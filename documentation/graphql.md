# GraphQL API

WordJS serves a GraphQL endpoint next to the REST API — queries, mutations and subscriptions:

```
GET  /api/v1/graphql?query=…&variables=…&operationName=…     queries
POST /api/v1/graphql            { "query": "…", "variables": { … }, "operationName": "…" }   queries and mutations
POST /api/v1/graphql            multipart/form-data (GraphQL multipart request spec)          uploads
GET  /api/v1/graphql/stream?query=subscription…               subscriptions (Server-Sent Events)
```

It is mounted under the API prefix like every REST route, so it works the same in monolith, split and
separate modes (the gateway sends every `/api/*` path to the backend) and sits behind the same host gate,
CORS policy, API rate limiter, install funnel and MFA compliance gate.

There is one rule for all of it: **a GraphQL field is the REST call it names, made in process as the same
caller.** A query field is a REST read, a mutation is a REST write, and every subscription event is re-read
through REST as the subscriber before it is sent. There is no second data layer and no second copy of the
authorization rules.

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

### Users, revisions, access levels and administrative resources

The same rule covers the reads beyond public content (`backend/src/core/graphql/resources.ts`). Each is
gated exactly as its REST twin, because it *is* that REST read:

| GraphQL                                   | REST read it performs            | Who gets an answer (REST's rule)                      |
|-------------------------------------------|----------------------------------|-------------------------------------------------------|
| `users(first:, after:, search:, role:)`   | `GET /users`                     | `list_users`                                          |
| `user(id:)`                               | `GET /users/:id`                 | the account itself, or `list_users`; `null` otherwise |
| `revisions(postId:)`, `ContentNode.revisions` | `GET /revisions/post/:postId` | whoever may edit the entry                            |
| `revision(id:)`                           | `GET /revisions/:id`             | whoever may edit the entry                            |
| `contentAccessLevels`                     | `GET /content-access/levels`     | `edit_posts`                                          |
| `webhooks`, `webhook(id:) { deliveries }`, `webhookEvents` | `GET /webhooks`, `/webhooks/:id`, `/webhooks/:id/deliveries`, `/webhooks/events` | administrators (the signing secret is never readable) |
| `plugins`                                 | `GET /plugins`                   | administrators                                        |
| `networkSites`                            | `GET /network/sites`             | network administrators, interactive session only      |
| `comments(status: "hold")`                | `GET /comments?status=hold`      | the status is honoured for a moderator only           |

`backend/src/tests/graphql-resources.test.ts` asks each question over REST and GraphQL for an anonymous
caller, a subscriber, two authors, an editor, an administrator and an API token, and asserts the same rows
or the same refusal.

## Mutations: every mutation is a REST write

Mutations use the same design. Each one dispatches the REST write it is named after, in process, as the same
caller (`backend/src/core/graphql/mutations.ts` → `restWrite` in `dispatch.ts`), so the capability family of
the type, the publish gate, ownership, the sudo re-authentication of a profile change, protected meta,
sanitizing, revisions, the audit log, hooks, webhooks and an API token's write scope are exactly the REST
ones:

| Mutation | REST write |
|----------|------------|
| `createContent(input:)`, `createPost(input:)`, `createPage(input:)` | `POST /posts` (`input.type` for any REST-exposed type) |
| `updateContent(id:, input:)` | `PUT /posts/:id` |
| `publishContent(id:)`, `unpublishContent(id:)` | `PUT /posts/:id` `{status: publish}` / `{status: draft}` |
| `scheduleContent(id:, date:)` | `PUT /posts/:id` `{status: future, date}` |
| `trashContent(id:)`, `restoreContent(id:, status:)` | `DELETE /posts/:id`; `POST /posts/:id/restore` (back to the status it had before the trash), then `PUT /posts/:id` when `status` is given |
| `deleteContent(id:)` | `DELETE /posts/:id?force=true` |
| `setContentMeta(id:, key:, value:)` | `POST /posts/:id/meta` |
| `restoreRevision(id:, postId:)`, `deleteRevision(id:)` | `POST /revisions/:id/restore`, `DELETE /revisions/:id` |
| `createTerm(taxonomy:, input:)`, `updateTerm(…)`, `deleteTerm(…)` | `POST/PUT/DELETE /categories` or `/tags` |
| `uploadMedia(file:, input:)`, `updateMedia(id:, input:)`, `deleteMedia(id:)` | `POST /media` (multipart), `PUT /media/:id`, `DELETE /media/:id` |
| `createComment(input:)`, `updateComment(id:, input:)` | `POST /comments`, `PUT /comments/:id` |
| `moderateComment(id:, action: APPROVE \| SPAM)`, `deleteComment(id:, force:)` | `POST /comments/:id/approve` / `spam`, `DELETE /comments/:id` |
| `createMenu`, `updateMenu`, `deleteMenu`, `assignMenuLocation`, `addMenuItem`, `updateMenuItem`, `deleteMenuItem` | the `/menus` writes |
| `updateSettings(values:)`, `updateSetting(key:, value:)` | `PUT /settings`, `PUT /settings/:key` |
| `updateViewer(input:)` | `PUT /users/me` |

```graphql
mutation Publish($input: ContentInput!) {
  createPost(input: $input) { node { id status link } }
}
```

What this means in practice:

- **Typed payloads** (`ContentPayload { node }`, `TermPayload { term }`, `MediaPayload { mediaItem }`,
  `CommentPayload`, `MenuPayload`, `MenuItemPayload`, `SettingsPayload`, `ViewerPayload`,
  `DeletePayload { id deleted previous }`) carry what REST answered, read for this caller.
- **A refusal is the REST refusal.** The field is `null` and the error's `extensions` carry the REST `code`
  and HTTP `status` (and the `params`/`details` REST named): a contributor's publish is held for review
  exactly as on REST, an author editing someone else's entry gets `rest_forbidden`/403, a `posts:read` token
  gets `rest_token_scope_insufficient`, an un-enrolled role under the MFA policy gets
  `mfa_enrollment_required` before any resolver runs, a password change without `currentPassword` gets
  `rest_bad_current_password`.
- **In order.** Mutation root fields run one after another (GraphQL's rule) and each write clears the
  request's read cache, so a later field sees what an earlier one wrote.
- **POST only.** A mutation over `GET` is answered `405` and nothing runs (and each mutation resolver checks
  the method again). With a session cookie a `POST` needs a same-origin `Origin` and the `X-CSRF-Token`
  header, like every REST write — so a cross-site page can never make a browser mutate.

The authorization parity table (`backend/src/tests/graphql-mutations.test.ts`) sends each REST write and the
GraphQL mutation that names it as the same caller, on the real app, and asserts the same refusal or the same
stored state. `MUTATION_REST_TWINS` (exported by `core/graphql`) is the machine-readable form of the table
above; the tests check that it lists exactly the Mutation root and that every twin is a real route, and that
every REST write the MCP server performs for an AI agent has its GraphQL mutation.

### Uploads

`uploadMedia(file: Upload!, input: MediaInput)` takes a file sent with the
[GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec):

```bash
curl -X POST https://example.com/api/v1/graphql \
  -H "Authorization: Bearer wjt_…" \
  -F operations='{"query":"mutation($f: Upload!) { uploadMedia(file: $f, input: { alt: \"Logo\" }) { mediaItem { id url } } }","variables":{"f":null}}' \
  -F map='{"0":["variables.f"]}' \
  -F 0=@logo.png
```

The file is re-streamed to `POST /media`, so multer's size limit, the type allow-list, the magic-byte check,
SVG rules, private uploads (`visibility: PRIVATE`), the site's storage quota and the upload rate limiter all
apply as for a direct upload. One file part per mapped variable; an `Upload` cannot be written inline.

Before the body is read, the request passes `POST /media`'s own authentication and `upload_files` check
(an anonymous caller gets `401 rest_not_logged_in`, a caller without the capability `403 rest_forbidden`, a
token without media write scope the REST scope error). Each file may be as large as the site's upload limit
(Settings → Media → «Maximum upload size»), and all the files of one request together as large as that same
limit (`413 rest_upload_too_large`); send larger batches as several requests. Every file after the first
counts once more against the upload rate limiter.

## Subscriptions: GraphQL over Server-Sent Events

```graphql
subscription {
  contentChanged(types: ["post"], kinds: [CREATED, UPDATED, DELETED]) { kind id cursor node { id title status } }
}
subscription { commentAdded(postId: 12) { cursor comment { id content authorName } } }
```

```bash
curl -N -H "Accept: text/event-stream" -H "Authorization: Bearer wjt_…" \
  "https://example.com/api/v1/graphql/stream?query=subscription%7BcontentChanged%7Bkind%20id%20node%7Btitle%7D%7D%7D"
```

The stream is `text/event-stream` in the "distinct connections" format of the GraphQL over SSE protocol:
`event: next` frames whose `data` is a GraphQL result (`{ "data": … }` or `{ "errors": … }`) with an `id:`
cursor, keep-alive comments every 15 seconds, and a final `event: complete`. A `POST` with a JSON body works
too. Only `subscription` operations are served there — queries and mutations get `400`
(`GRAPHQL_NOT_A_SUBSCRIPTION`) — and `/graphql` does not run subscriptions.

**Why SSE and not graphql-ws.** Every WordJS request crosses the same HTTP chain (host gate, CORS, rate
limiter, CSRF, the MFA gate, the gateway in split and separate modes). An SSE stream is one HTTP response
behind all of it, authenticated by the same cookie or Bearer token, proxied by the gateway like the
collaboration stream already is, and resumable with the standard `Last-Event-ID` header. A WebSocket
protocol would need an upgrade path outside the Express middleware, its own authentication handshake and a
gateway WebSocket route, for a feed that only flows server → client. Off-the-shelf clients
([graphql-sse](https://github.com/enisdenjo/graphql-sse) in distinct-connections mode, or a plain
`EventSource`) work.

**Where events come from.** Not from in-process hooks — on a multi-node install the write and the subscriber
may be on different nodes. While a node has subscribers it polls two durable, committed sources once a second:
the content outbox (`post.created` / `post.updated` / `post.deleted`, written in the same transaction as the
change) and the comments table. Both are read by id with a look-back window, so a transaction that committed
out of id order is still delivered once.

**Authorization is per event, as the subscriber.** The feed carries ids only. Before an event is sent, the
subscription re-reads the entry through REST as the subscriber — `GET /posts/:id` or `GET /comments/:id`,
fresh, never cached — so the subscriber sees exactly what REST would show it at that moment:

- an anonymous stream hears about published entries and never learns a draft exists; an author's stream
  carries their own drafts; a token's stream follows its scope;
- an entry that stops being visible (trashed, unpublished, made private) arrives as `DELETED` with
  `node: null` — and only on a stream that had seen it (or that named it in `ids:` and could read it then);
  an entry that becomes visible arrives as `CREATED`;
- `commentAdded` delivers only comments the subscriber may read (approved ones, on entries it can see; held
  ones to a moderator);
- an authenticated stream re-proves its credential every 30 seconds (`GET /users/me`): a revoked token, a
  signed-out or expired session closes it with an error frame.

**Resuming.** Every frame carries its cursor as the SSE `id`. A client that reconnects with
`Last-Event-ID: <cursor>` receives what was committed after it (up to 500 events, 50 for a stream opened
without a credential), each authorized as above. A stream ends after an hour; reconnect with the last
cursor. Streams are capped per process and per caller — a signed-in user, else the client address (an IPv6
client is its /64) — see the limits table, answered `429 graphql_stream_limit` beyond. The reads a stream
makes while it opens (one per entry named in `ids:`, one per replayed event) count against the API rate
limiter like any GraphQL read; the live events after it do not.

`backend/src/tests/graphql-subscriptions.test.ts` drives real streams over a socket: anonymous vs author
visibility, `DELETED` on trash/unpublish, a revoked token closing its stream, held comments, the transport
rules and resuming.

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
connection. `link` is the canonical public URL (`<siteUrl>/<slug>` for posts and pages, as REST answers it).
`posts(status:)` follows REST: an anonymous caller asking for `draft`, `pending`, `private` or `future` gets
an empty connection (`totalCount: 0`), and `any` lists the published entries. `Term` has a `contentNodes`
connection for its category/tag archive. Introspect the schema in
development for the full field list.

Custom post types are read with `contentNodes(type: "book")` / `contentNode(id:, type:)` under the same
rules REST applies to them (a non-public type is visible only to its authors and editors). Terms of custom
taxonomies are not exposed because the REST API does not expose them either; GraphQL mirrors the REST
surface exactly.

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
| Max mutations / document | 10   | `WORDJS_GRAPHQL_MAX_MUTATIONS` (1–100)                          |
| Max selected fields / operation | 1000 (fragments expanded) | `WORDJS_GRAPHQL_MAX_FIELDS` (50–100000)      |
| Max aliased fields / selection set | 50 | `WORDJS_GRAPHQL_MAX_ALIASES` (1–10000)                     |
| Max response size     | 16 MiB  | `WORDJS_GRAPHQL_MAX_RESPONSE_BYTES` (64 KiB–512 MiB)            |
| Open subscription streams | 500 per process, 5 per caller | `WORDJS_GRAPHQL_MAX_STREAMS`, `WORDJS_GRAPHQL_MAX_STREAMS_PER_CLIENT` |
| Introspection         | on in development, **off in production** | `graphql_introspection` setting (`"1"` / `"0"`, admin-only, `PUT /api/v1/settings`) |
| Rate limit            | the global API limiter (`WORDJS_API_RATELIMIT_MAX` / `_WINDOW_MS`), charged per REST read | — |

Depth, cost, fields and aliases are checked at **validation**, before any resolver (or REST sub-request)
runs, and are measured with fragments expanded. The cost model (`backend/src/core/graphql/limits.ts`): a
field that returns an object costs 1, a scalar costs 0.1, a field backed by a REST read costs 5 more, and a
paginated field multiplies its subtree — leaves included — by its `first` (the default when absent, the
maximum when it is a variable). Aliases are counted one by one. An operation may select at most 1000 fields
once its fragments are expanded, and one selection set may hold at most 50 aliased fields, counting the
fragments spread into it. A refusal is an error with `extensions.code` `GRAPHQL_DEPTH_LIMIT`,
`GRAPHQL_COST_LIMIT`, `GRAPHQL_FIELD_LIMIT` or `GRAPHQL_ALIAS_LIMIT` and the measured value.

A result is measured before it is serialized: one larger than the response cap is answered with a single
`GRAPHQL_RESPONSE_TOO_LARGE` error and no data (a subscription event that large is replaced by that error).
Ask for fewer fields or a smaller page.

The API rate limiter counts the GraphQL request once, and each REST read after the first that the query
dispatches counts once more, so a query costs the budget what the REST calls behind it would. Past the
limit the remaining fields resolve to the REST `429` (`rest_rate_limited`).

Mutations count too: a mutation field costs 20 more than the same selection as a read (on top of the REST
read cost), and a document may hold at most **10** mutation fields (`WORDJS_GRAPHQL_MAX_MUTATIONS`, 1–100),
aliases and fragment spreads counted one by one — the API rate limiter counts a GraphQL request once, so the
cap is what keeps one document from carrying an unbounded batch of writes. A refusal has
`extensions.code` `GRAPHQL_MUTATION_LIMIT`, and nothing in the document runs.

Persisted queries are not supported.

### CSRF and clients

`GET` is a safe method and needs no CSRF token — anonymous and server-side clients (a static-site
generator, a Next.js server component) should send their queries as `GET`, or `POST` with a `Bearer`
token. Mutations are `POST` only. A `POST` follows the same CSRF rule as every REST write: it must carry a
same-origin `Origin` (or `Referer`) header, and a cookie-authenticated `POST` also needs `X-CSRF-Token`.
The subscription stream is a `GET` too: with a session cookie it must be same-origin (the rule the
collaboration stream applies). Responses are sent with `Cache-Control: no-store`.

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
- Resolvers receive `ctx.rest.get(path, query)` (the in-process REST dispatcher, memoized per request),
  `ctx.rest.write(method, path, { body, query })` for a REST write, and `ctx.req`. Reading and writing
  WordJS data through `ctx.rest` keeps your field's authorization identical to REST. An extension may add
  `Mutation` fields (`extend type Mutation`): they count against the mutation cap and cost like any write,
  and `ctx.rest.write` refuses to run on anything but a POST request.
- Declare `cost` for fields that do real work: `{ rest: true }` for one read, `{ rest: true, list: true,
  defaultFirst: 10 }` for a page. Without it a field costs what a plain field costs.
- The schema is rebuilt automatically when the registry or the hook's callbacks change;
  `unregisterGraphQLExtensions(owner)` removes an owner's extensions.

**Sandboxed plugins.** The registration hook is host-only (`core/hook-access` classifies
`wordjs_graphql_register_types` as denied): its argument is a function and its product is executable
resolvers, neither of which can cross the isolate boundary. A sandboxed plugin extends the schema
**declaratively** instead, from its `init`, with `wordjs.graphql.extend`: SDL plus, for each new `Query`
field, which of its own GET routes (`wordjs.http.route`) answers it.

```js
exports.init = (wordjs) => {
    wordjs.http.route('get', '/books', (req, res) => res.json(listBooks(Number(req.query.first) || 10)));
    wordjs.http.route('get', '/books/:id', (req, res) => { /* … res.json(book) or res.status(404) */ });
    wordjs.http.route('get', '/shelf', { auth: true }, (req, res) => res.json(shelfOf(req.user.id)));

    wordjs.graphql.extend({
        typeDefs: `
            type Book { id: Int! title: String }
            type Shelf { count: Int }
            extend type Query { books(first: Int): [Book!]! book(id: Int!): Book myShelf: Shelf }
        `,
        fields: {
            'Query.books':   { path: '/books', list: true },  // GET /api/v1/plugin/<slug>/books?first=…
            'Query.book':    { path: '/books/:id' },          // :id takes the field argument `id`
            'Query.myShelf': { path: '/shelf' },              // the route's { auth: true } applies
        },
    });
};
```

- The host builds the resolvers (`core/graphql/plugin-bridge.ts`) and calls the route **as the GraphQL
  caller**: a `:name` path segment takes the field argument of that name (URL-encoded), every other scalar
  argument goes in the query string, and the route's JSON body is the field's value — a `404` is `null`,
  a `401`/`403` is a field error with code `UNAUTHENTICATED`/`FORBIDDEN`. The route's own middleware
  (`auth`, `admin`, the site gate) authorizes it, and the plugin code that answers runs in its sandbox, so
  a field shows exactly what the REST route would show that caller.
- Only `Query.<field>` entry points take a route; nested fields read the route's JSON. At most 50 routed
  fields and 5 `extend` calls per plugin, SDL up to 20 000 characters. Every routed field costs a REST read
  (`list: true` makes it a page). The extension rules above still apply, so a declaration that names an
  existing field (`Query.posts`) or a type that already exists is refused as a whole and logged.
- The routes need the plugin's `express:register_route` grant, as always. Its extensions belong to the site
  whose worker registered them and disappear when the plugin is deactivated.

## Choice of library

- [`graphql`](https://github.com/graphql/graphql-js) 17.x (MIT) — the reference implementation, no
  dependencies. Its experimental fragment arguments stay disabled (`parseWithLimits`): the cost walk
  measures each fragment once and reuses the figure at every spread.
- [`graphql-http`](https://github.com/graphql/graphql-http) 1.x (MIT) — the GraphQL-over-HTTP reference
  server, no runtime dependencies, with an Express adapter.

Neither adds a transitive dependency, and `npm audit` reports no advisory for either. The depth and cost
rules are ~150 lines in-tree rather than an extra package.
