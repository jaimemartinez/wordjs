# ADR-0002: F1 declarative content schema

- Status: Accepted
- Date: 2026-08-20
- Depends on: ADR-0001

## Context

WordJS registered content types as permissive runtime objects. The registry described menu labels and
a small `supports` list, while storage, relationships, permissions and revision behavior remained
implicit across models and routes. Plugins could attach arbitrary keys, but no portable contract
existed from which later phases could generate validators, DTOs, OpenAPI or frontend clients.

F0 froze that behavior and requires `registerPostType(name, args)` plus unknown extension keys to remain
compatible during migration.

## Decision

F1 introduces `ContentTypeSchemaV1`, published as `backend/content-schema.v1.json`. A normalized schema
always declares:

1. identity, labels and visibility;
2. editor features and typed fields;
3. relationships and their storage bindings;
4. the posts/post_meta storage discriminator;
5. capability family and operation mapping;
6. revision strategy, codec version, fields and meta keys;
7. presentation metadata; and
8. a namespaced JSON-only extension object.

`registerContentType(schema)` is the native API. It validates the complete shape, stores a defensive
serializable copy and projects the historical post-type object consumed by existing code.

`registerPostType(name, args)` remains an adapter. Known properties become a v1 schema. Unknown keys stay
on the runtime projection by reference; their JSON-safe subset is also copied into `extensions`.
Functions, cyclic objects and other process-local values never enter the portable schema.

Built-in `post`, `page`, `attachment`, `nav_menu_item` and `revision` types originate from declarative
schemas. `custom_content_schemas` is the new persisted source. During the compatibility window writes
are mirrored to `custom_post_types`, and boot adapts legacy-only entries that have not yet been migrated.

## Invariants

### F1-INV-01 — Portable data only

Every value returned by `getContentTypeSchema(s)` survives JSON serialization and validation. Executable
callbacks, prototypes, dangerous object keys, cycles, non-finite numbers and unbounded structures fail
closed or remain confined to the legacy runtime projection.

### F1-INV-02 — Closed executable surface

F1 describes storage but executes none of it dynamically. Column, table, field type, relationship kind
and storage-engine vocabularies are allowlisted. Arbitrary schema strings never become SQL identifiers.

### F1-INV-03 — Complete built-ins

Every built-in post-table discriminator has a schema containing all F1 sections. Internal types remain
non-REST and protected from unregistering.

### F1-INV-04 — Legacy compatibility

Valid historical declarations preserve labels, defaults, supports, taxonomies, capability families and
unknown runtime extension keys. Existing consumers continue reading `getPostType(s)`.

### F1-INV-05 — One registered pair

For every registered post type there is exactly one schema and one compatibility projection with the
same name, visibility, features, taxonomies and capability family.

### F1-INV-06 — Explicit permissions

Every schema declares all create/edit/publish/delete and ownership-aware capabilities. F1 does not yet
replace route authorization; F2 may generate policies from these declarations after parity tests exist.

### F1-INV-07 — Versioned revisions

Revision behavior declares an enabled flag, snapshot strategy, positive codec version, field list and
meta-key list. F4 may introduce new codecs but cannot reinterpret old snapshots silently.

### F1-INV-08 — Compatible persistence

Native schemas persist in `custom_content_schemas`. Writes are dual-published to `custom_post_types` and
legacy-only records are adapted at boot. A malformed persisted entry is skipped without bricking boot.

### F1-INV-09 — Defensive reads

Schema query APIs return fresh copies. A caller cannot mutate registry policy by changing an object it
received from `getContentTypeSchema` or the REST API.

### F1-INV-10 — F2 boundary

F1 is data plus validation and compatibility projection only. Runtime request validators, generated
DTOs, OpenAPI, route policies and frontend clients belong to F2 and must consume this contract rather
than create a second schema language.

## REST compatibility

Existing `/types` list/detail responses remain available. Additive `GET /types/schemas` and
`GET /types/{name}/schema` endpoints expose the portable declarations. `POST /types` accepts either the
legacy body or a full `schemaVersion: 1` declaration, awaits persistence before returning `201`, and
rejects malformed declarations with `400`.

## Consequences

- F2 has a stable, executable-data-free input.
- Existing plugins and admin code keep their legacy projection.
- Storage remains the current posts/meta/terms model in F1; alternate engines require a later schema
  version rather than an unchecked string.
- Dual-write is temporary migration debt and will be removed only after the compatibility window in F6.
