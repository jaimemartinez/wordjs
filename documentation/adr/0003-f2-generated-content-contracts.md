# ADR-0003: F2 generated content contracts

- Status: accepted
- Date: 2026-08-20
- Depends on: ADR-0001 and ADR-0002

## Context

F1 made content types portable, but the generic content route still had four manually maintained
representations: request shape checks in `posts.ts`, capability-name reconstruction in
`post-capabilities.ts`, handwritten Swagger request bodies, and a frontend `Partial<Post>` client that
used a response DTO as a write DTO. Those copies could accept different values or enforce different
permissions even when the declarative content schema was correct.

## Decision

F2 compiles each normalized F1 schema into one executable contract containing request validators,
route policy, create/update OpenAPI schemas and deterministic TypeScript artifacts. The generated
frontend client has separate create, update and response DTOs. The generic content routes consume the
compiled validator and policy; Swagger and the frontend consume their respective projections.

### F2-INV-01 — One schema language

F1 `ContentTypeSchemaV1` is the only authoring format. F2 projections may map its names onto the
existing REST wire names, but may not introduce an independent field, permission or revision schema.

### F2-INV-02 — Deterministic generation

Built-in DTOs and the frontend client are deterministic outputs of the built-in F1 declarations.
`generate-f2-contracts.ts` checks drift by default and only rewrites with explicit `--write`.

### F2-INV-03 — Runtime validation

`POST /posts` and `PUT /posts/:id` validate every declared field they receive before mutation. Type,
enum, discriminator, required-field and bounded JSON failures return the stable
`rest_content_contract_invalid` response. Unknown transport keys remain intact for F0 plugin
compatibility; executable or prototype-bearing JSON never becomes valid by being an extension.

### F2-INV-04 — Typed public handlers

Every handler in the generic content router uses an explicit Express request body, path and query DTO.
No public handler in `routes/posts.ts` uses `req:any`. Dynamic plugin metadata stays `unknown` until a
schema validator or an existing sanitizer narrows it.

### F2-INV-05 — Declared policy is executable

The eight capability operations stored in F1 are used verbatim. They are not reconstructed from
`capabilityType` for registered content. Edit and delete policy include type, ownership and published
state and are shared by posts, revisions and collaboration callers. Public reads also obey the declared
`visibility.public` flag instead of assuming that every published REST record is anonymous. Capability-
family construction is retained only for orphaned pre-F1 content compatibility.

### F2-INV-06 — OpenAPI follows runtime declarations

Swagger receives one create and update component for every REST-exposed schema. Creation uses a
discriminator-backed generic `oneOf`; partial updates use `anyOf`, because the record URL already
selects the type and an omitted `type` can legitimately match several partial schemas. Because
documentation is initialized lazily, custom schemas registered during boot are included; isolated
tooling falls back to the pure built-in list.

### F2-INV-07 — Separate wire DTOs

`ContentCreateInput`, `ContentUpdateInput` and `ContentRecord` are different generated types. A caller
can no longer submit `Partial<Post>` and accidentally treat response-only fields as accepted writes.
The generated client owns content paths, query encoding and return types.

### F2-INV-08 — Custom and legacy compatibility

Native F1 schemas get their exact fields and capabilities. `registerPostType` schemas use the same
compiler. Unknown legacy request keys are preserved, orphaned rows remain manageable through the F0
capability fallback, and internal `showInRest:false` types remain inaccessible to generic writes.

### F2-INV-09 — F3 boundary

F2 validates and authorizes; it does not change mutation atomicity. Post, meta, taxonomy, revision and
hook writes still use their current sequence. A transaction-scoped `ContentMutationService` and outbox
belong to F3 and must not be simulated inside generated validators or clients.

### F2-INV-10 — Drift is a CI failure

CI runs deterministic generation checks, semantic F2 verification, backend/frontend typechecks and
contract tests. A schema edit that does not update DTOs, OpenAPI, policy, validation or the client is a
red build rather than a silent compatibility divergence.

## Consequences

- Custom capability maps now work as declared instead of being reduced to a naming convention.
- OpenAPI request bodies describe the actual generic content DTOs, including scheduled content.
- Frontend content writes have compile-time input types while arbitrary plugin metadata remains an
  explicit `unknown` boundary.
- The route still contains mutation sequencing that F3 must make atomic; F2 does not conceal that debt.
