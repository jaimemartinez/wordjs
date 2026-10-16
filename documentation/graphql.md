# GraphQL API (read-only, phase 1)

WordJS serves a GraphQL endpoint next to the REST API:

```
GET  /api/v1/graphql?query=…&variables=…&operationName=…
POST /api/v1/graphql            { "query": "…", "variables": { … }, "operationName": "…" }
```

It is mounted under the API prefix like every REST route, so it works the same in monolith, split and
separate modes (the gateway sends every `/api/*` path to the backend) and sits behind the same host gate,
CORS policy, API rate limiter, install funnel and MFA compliance gate.

Phase 1 is **read-only**. There are no mutations; a `mutation` document is refused because the schema has
no mutation root. Writes stay on the REST API.

## How it is authorized: every field is a REST read

GraphQL in WordJS is a query language over the REST API, not a second data layer. Each resolver that
touches data dispatches the matching REST read **in process**, as the same caller
(`backend/src/core/graphql/dispatch.ts`, the WordJS counterpart of WordPress's `rest_do_request()`):

| GraphQL                                     | REST read it performs                     |
|---------------------------------------------|-------------------------------------------|
| `posts`, `pages`, `contentNodes(type:)`     | `GET /posts?type=…&page=…&per_page=…`     |
| `post(id:)`, `page(id:)`, `contentNode(id:)`| `GET /posts/:id`                          |
| `…(slug:)`                                  | `GET /posts/slug/:slug?type=…`            |
| `categories`, `category(id:)`, `tags`, `tag(id:)` | `GET /categories`, `GET /tags` (+ `/:id`) |
| `taxonomies`, `taxonomy(name:)`             | `GET /taxonomies`, `GET /taxonomies/:name`|
| `contentTypes`, `contentType(name:)`        | `GET /types`, `GET /types/:name`          |
| `mediaItems`, `mediaItem(id:)`              | `GET /media`, `GET /media/:id`            |
| `menus`, `menu(id:)`, `menu(location:)`     | `GET /menus`, `GET /menus/:id`, `GET /menus/location/:location` |
| `comments`, `comment(id:)`, `ContentNode.comments` | `GET /comments?post=…`, `GET /comments/:id` |
| `settings`                                  | `GET /settings` (the public subset)       |
| `viewer`                                    | `GET /users/me`                           |

The sub-request inherits the incoming request's headers, cookies, client IP and host, so `optionalAuth`,
the capability checks, the serializer and the full-text search are the REST ones. Consequently, for the
same caller:

- **Anonymous** callers see published, public content only — exactly what the REST API shows them.
- **Drafts, pending, scheduled and private entries** follow REST: the author sees their own, a holder of
  the type's `edit_others_*` / `read_private_*` capability sees everyone's, nobody else sees any.
- **Password-protected entries** return an empty `content`/`excerpt` (and no page-builder tree or featured
  image) to anyone who does not manage them, and search does not match their hidden body.
- **Media** inherit their parent entry's visibility; private media are hidden from anyone who may not
  edit them.
- **Comments** are the approved ones, and only on entries the caller may read.
- **Authors** expose only `id`, `name` (display name) and `slug` — never the login or email.
- **Scoped API tokens** keep applying **per field**: a `posts:read` token reads posts through GraphQL and
  is anonymous for media, users and so on, as it is on the corresponding REST endpoints.

A single-object lookup that REST answers `404` (absent *or* not visible to this caller — REST does not
distinguish, so neither does GraphQL) resolves to `null`. Any other REST refusal becomes a GraphQL error
whose `extensions` carry the REST `code` and HTTP `status`.

The parity is enforced by `backend/src/tests/graphql-api.test.ts`, which runs each GraphQL query and the
corresponding REST request side by side for an anonymous caller, the owner, another author and an editor,
over published, draft, private and password-protected content.

## Schema overview

```graphql
type Query {
  posts(first: Int, after: String, search: String, status: String, orderBy: ContentOrderBy, order: Order,
        categories: [String!], tags: [String!], author: [String!]): ContentConnection!
  pages(...same arguments...): ContentConnection!
  contentNodes(type: String, ...same arguments...): ContentConnection!
  post(id: Int, slug: String): ContentNode
  page(id: Int, slug: String): ContentNode
  contentNode(id: Int, slug: String, type: String): ContentNode
  categories(first: Int, after: String, search: String, parent: Int, hideEmpty: Boolean,
             orderBy: TermOrderBy, order: Order): TermConnection!
  category(id: Int!): Term
  tags(...): TermConnection!
  tag(id: Int!): Term
  taxonomies(postType: String): [Taxonomy!]!
  taxonomy(name: String!): Taxonomy
  contentTypes: [ContentType!]!
  contentType(name: String!): ContentType
  mediaItems(first: Int, after: String, search: String, mimeType: String,
             orderBy: MediaOrderBy, order: Order): MediaConnection!
  mediaItem(id: Int!): MediaItem
  menus: [Menu!]!
  menu(id: Int, location: String): Menu
  comments(first: Int, after: String, postId: Int, parentId: Int, search: String,
           orderBy: CommentOrderBy, order: Order): CommentConnection!
  comment(id: Int!): Comment
  settings: Settings!
  viewer: Viewer
}
```

`ContentNode` carries the REST post fields (`id`, `type`, `slug`, `status`, `title`, `excerpt`, `content`,
dates, `link`, `protected`, `menuOrder`, `language`, `translations`, `meta`, …) plus `author`,
`featuredMedia { id url path title mediaItem }`, `categories`, `tags`, `parent` and a `comments`
connection. `Term` has a `contentNodes` connection for its category/tag archive. Introspect the schema in
development for the full field list.

Custom post types are read with `contentNodes(type: "book")` / `contentNode(id:, type:)` under the same
rules REST applies to them (a non-public type is visible only to its authors and editors). Terms of custom
taxonomies are not exposed because the REST API does not expose them either; phase 1 mirrors the REST
read surface exactly.

### Pagination

Lists are cursor connections:

```graphql
{
  posts(first: 10, after: "d2pzOjk") {
    totalCount
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    edges { cursor node { id title } }
    nodes { id title }
  }
}
```

`first` is 1–100 (default 10; the REST page cap is 100, and a GraphQL page is never larger than the read
behind it). `after` takes an opaque cursor from a previous page; pass `pageInfo.endCursor` to continue.
`totalCount` is REST's `X-WP-Total` for this caller.

## Server protection

| Guard                 | Default | Configure                                                       |
|-----------------------|---------|-----------------------------------------------------------------|
| Max query depth       | 10      | `WORDJS_GRAPHQL_MAX_DEPTH` (2–50)                              |
| Max query cost        | 1000    | `WORDJS_GRAPHQL_MAX_COST` (50–100000)                          |
| Max parser tokens     | 5000    | `WORDJS_GRAPHQL_MAX_TOKENS` (100–100000)                       |
| Max page size         | 100     | fixed (the REST page cap)                                       |
| Introspection         | on in development, **off in production** | `graphql_introspection` setting (`"1"` / `"0"`, admin-only, `PUT /api/v1/settings`) |
| Rate limit            | the global API limiter (`WORDJS_API_RATELIMIT_MAX` / `_WINDOW_MS`) | — |

Depth and cost are checked at **validation**, before any resolver (or REST sub-request) runs, and are
measured with fragments expanded. The cost model (`backend/src/core/graphql/limits.ts`): a field that
returns an object costs 1, a scalar costs 0, a field backed by a REST read costs 5 more, and a paginated
field multiplies its subtree by its `first` (the default when absent, the maximum when it is a variable).
Aliases are counted one by one. A refusal is an error with `extensions.code` `GRAPHQL_DEPTH_LIMIT` or
`GRAPHQL_COST_LIMIT` and the measured value.

Persisted queries are not part of phase 1.

### CSRF and clients

`GET` is a safe method and needs no CSRF token — anonymous and server-side clients (a static-site
generator, a Next.js server component) should send their queries as `GET`, or `POST` with a `Bearer`
token. A `POST` follows the same CSRF rule as every REST write: it must carry a same-origin `Origin` (or
`Referer`) header, and a cookie-authenticated `POST` also needs `X-CSRF-Token`. Responses are sent with
`Cache-Control: no-store`.

## Extending the schema

`backend/src/core/graphql/extensions.ts` is the seam. An extension is SDL plus resolvers:

```ts
const { registerGraphQLExtension } = require('./core/graphql');

registerGraphQLExtension({
    owner: 'reading-time',
    typeDefs: `
        type ReadingTime { minutes: Int! }
        extend type ContentNode { readingTime: ReadingTime }
        extend type Query { postTitle(id: Int!): String }
    `,
    resolvers: {
        ContentNode: {
            readingTime: (post) => ({ minutes: Math.ceil(String(post.content).split(/\s+/).length / 200) }),
        },
        Query: {
            postTitle: {
                cost: { rest: true },              // feeds the cost limit; declare it for real work
                resolve: async (_root, { id }, ctx) => {
                    const r = await ctx.rest.get(`/posts/${id}`);   // same caller, REST authorization
                    return r.status === 200 ? r.body.title : null;
                },
            },
        },
    },
});
```

Host code that runs at boot can also contribute through the action hook the schema builder fires on every
(re)build:

```ts
addAction('wordjs_graphql_register_types', (register) => register({ owner, typeDefs, resolvers }));
```

Rules, enforced by the builder:

- An extension may add types and add fields to existing types (`extend type …`). It may **not** attach a
  resolver to a field that existed before it, so it cannot reroute a core field around REST authorization.
- Each extension is validated on its own; one with invalid SDL, a name clash or a resolver for an unknown or
  pre-existing field is logged and skipped, and the endpoint keeps serving everyone else.
- Resolvers receive `ctx.rest.get(path, query)` (the in-process REST dispatcher, memoized per request) and
  `ctx.req`. Reading WordJS data through `ctx.rest` keeps your field's authorization identical to REST.
- Declare `cost` for fields that do real work: `{ rest: true }` for one read, `{ rest: true, list: true,
  defaultFirst: 10 }` for a page. Without it a field costs what a plain field costs.
- The schema is rebuilt automatically when the registry or the hook's callbacks change;
  `unregisterGraphQLExtensions(owner)` removes an owner's extensions.

**Sandboxed plugins.** The registration hook is host-only (`core/hook-access` classifies
`wordjs_graphql_register_types` as denied): its argument is a function and its product is executable
resolvers, neither of which can cross the isolate boundary. A declarative, route-backed bridge — a plugin
declares SDL and maps each field to one of its own `/api/v1/plugin/<slug>/…` routes, so the plugin's route
authorization applies — is planned for a later phase.

## Choice of library

- [`graphql`](https://github.com/graphql/graphql-js) 16.x (MIT) — the reference implementation, no
  dependencies. 16.x rather than 17.x because 17 requires Node 22+ and the backend supports Node ≥ 20.9.
- [`graphql-http`](https://github.com/graphql/graphql-http) 1.x (MIT) — the GraphQL-over-HTTP reference
  server, no runtime dependencies, with an Express adapter.

Neither adds a transitive dependency, and `npm audit` reports no advisory for either. The depth and cost
rules are ~150 lines in-tree rather than an extra package.
