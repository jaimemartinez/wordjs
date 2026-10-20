# Tutorial 14 — Read your content with GraphQL

WordJS has a GraphQL endpoint at `/api/v1/graphql`, next to the REST API. With it, a static
site generator, a mobile app or another site can ask for exactly the fields it needs in one request.
In this tutorial you send a few queries with `curl`, then write a small script that builds a static
page from your posts. Writes (mutations) and live updates (subscriptions) are in [graphql.md](../graphql.md).

**Time:** about 15 minutes.
**You need:** a WordJS site with some posts, such as the ones from
[Tutorial 6](06-import-a-wordpress-site.md). You also need `curl` and Node.js 18 or newer on any
machine. No account is needed for public content.

## 1. Your first query

GraphQL takes the query as text. Send it with **GET**:

```bash
curl -s -G https://<your-site>/api/v1/graphql --data-urlencode 'query={ settings { title description url } menus { id name } }'
```

```json
{"data":{"settings":{"title":"Tutorial Lab","description":"","url":"https://www.example.com"},"menus":[{"id":5,"name":"Header"},{"id":2,"name":"Main Menu"}]}}
```

Use **GET** from scripts and servers. A **POST** follows the same anti-forgery rule as every REST
write: it is refused (*Cross-site request blocked.*) unless it carries a same-origin `Origin` header
or a `Bearer` token.

## 2. List posts, with their authors and categories

```bash
curl -s -G https://<your-site>/api/v1/graphql --data-urlencode 'query={ posts(first: 2) { totalCount pageInfo { hasNextPage endCursor } nodes { id title slug date author { name slug } categories { name slug } } } }'
```

```json
{"data":{"posts":{"totalCount":5,"pageInfo":{"hasNextPage":true,"endCursor":"d2pzOjE"},
 "nodes":[{"id":4,"title":"How the home page was built — without code","slug":"how-the-home-page-was-built", …}]}}}
```

Lists are **connections**:

- `nodes` holds the items;
- `totalCount` is the total for you;
- `pageInfo.endCursor` is where the next page starts.

To get the next page, pass that cursor as `after`:

```bash
curl -s -G https://<your-site>/api/v1/graphql --data-urlencode 'query={ posts(first: 2, after: "d2pzOjE") { nodes { title } pageInfo { hasNextPage } } }'
```

`first` goes up to 100.

## 3. One post, with variables

Pass values as **variables** rather than pasting them into the query:

```bash
curl -s -G https://<your-site>/api/v1/graphql --data-urlencode 'query=query One($slug: String) { post(slug: $slug) { title link excerpt comments(first: 5) { nodes { authorName content } } } }' --data-urlencode 'variables={"slug":"how-we-brew-a-pour-over"}'
```

```json
{"data":{"post":{"title":"How we brew a pour-over","link":"https://www.example.com/how-we-brew-a-pour-over",
 "excerpt":"Our three-stage pour-over recipe.",
 "comments":{"nodes":[{"authorName":"Leo","content":"Tried it this morning. Great tip about the rinse!"}]}}}}
```

A post that doesn't exist, or that you may not see, comes back as `null`.

## 4. Build a static page from it

[`files/graphql-build.mjs`](files/graphql-build.mjs) is a 50-line script without dependencies:

1. It reads every published post, page by page with the cursor.
2. It reads the site title.
3. It writes an `index.html` that lists the posts with their author and date.

```bash
WORDJS_URL=https://<your-site> node graphql-build.mjs
```

```
Wrote index.html with 5 posts from https://www.example.com
```

The script's helper sends each query as GET with its variables:

```js
async function graphql(query, variables = {}) {
  const url = new URL('/api/v1/graphql', SITE);
  url.searchParams.set('query', query);
  url.searchParams.set('variables', JSON.stringify(variables));
  const body = await (await fetch(url)).json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}
```

To rebuild whenever something is published, trigger the script from a webhook
([Tutorial 13](13-webhooks.md)).

## What you can and can't see

Every field is answered by the matching REST read, as **you**. A query never reveals more than the
REST API would:

- **Anonymous** requests see published, public content only. Asking for `posts(status: "draft")`
  without signing in still returns only published posts.
- **Signed-in users and API tokens** see what they would see over REST: authors see their own drafts,
  editors see everyone's. A token scoped to `posts:read` reads posts and is anonymous for everything
  else.
- Authors expose only their display name and slug, never the login or email.

Writes are **mutations**, accepted over `POST` only and authorized exactly like the REST write each one
names, so an anonymous `mutation { … }` is refused just as the REST write would be. They are covered in
[graphql.md](../graphql.md#mutations-every-mutation-is-a-rest-write).

## Good to know

- **Introspection** (`__schema`) is **off in production**. An administrator can turn it on with the
  `graphql_introspection` setting. The schema overview and every field are in
  [graphql.md](../graphql.md).
- Query **depth and cost are limited** (10 levels, cost 1000 by default), and the limits are checked
  before any data is read. A too-large query is refused with `GRAPHQL_DEPTH_LIMIT` or
  `GRAPHQL_COST_LIMIT`.

---
*Tested on 2026-10-17, anonymously.

- **WordJS 2.6.0:**
  - every query above, including pagination with the cursor;
  - the `null` for a missing post;
  - `posts(status: "draft")` returning only published posts;
  - introspection refused in production;
  - a mutation refused;
  - an anonymous POST without `Origin` refused with `rest_csrf_invalid`, and accepted with a
    same-origin `Origin`.
- **WordJS 2.7.0 release build, again:** pagination, the `null` lookup, the mutation and POST refusals,
  `link` now the post's canonical address (answering `200` directly), and `graphql-build.mjs` writing a
  page of the site's posts with every link kept.

The responses shown are from those runs.*
