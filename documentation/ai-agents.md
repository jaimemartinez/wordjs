# AI agents and the MCP server 🤖

WordJS ships a [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants (Claude
Code, Claude Desktop, any MCP-capable agent framework) can read and draft content on a site. It applies the
same model WordJS uses for plugins: **the connection requests capabilities, an administrator grants them**,
and whatever is granted can only ever *narrow* what the bound user may do.

## 1. Quick start

1. **Admin → AI agents** (`/admin/agents`, needs `manage_api_tokens`). Name the connection and tick the
   capabilities it requests. The connection is created **pending** and its `wja_…` token is shown **once**,
   together with ready-to-paste client configuration.
2. An **administrator** reviews the request and grants a subset of it (the review panel opens right away
   when an administrator created the connection).
3. Point the client at the endpoint:

   ```bash
   claude mcp add --transport http wordjs https://example.com/api/v1/mcp --header "Authorization: Bearer wja_…"
   ```

   or, in `.mcp.json` and compatible clients:

   ```json
   { "mcpServers": { "wordjs": { "type": "http", "url": "https://example.com/api/v1/mcp",
       "headers": { "Authorization": "Bearer wja_…" } } } }
   ```

A pending connection can connect, but is offered only the `whoami` tool until something is granted.

## 2. Capabilities

| Grant | What it allows | Product capabilities it can unlock (only if the user holds them) |
|---|---|---|
| `content:read` | list, search and read entries, terms and media | `read_private_*` of every content type |
| `content:draft` | create drafts, edit drafts, submit for review (implies `content:read`) | `edit_*`, `edit_others_*` (create/edit) of every content type |
| `content:publish` | publish, edit live content (implies `content:draft`) | `publish_*`, `edit_published_*` |
| `media:upload` | upload files (same checks as a browser upload) | `upload_files` |
| `taxonomy:write` | create categories and tags | `manage_categories` |
| `comments:moderate` | read the moderation queue, approve, mark as spam | `moderate_comments` |
| `settings:read` | the public site identity (name, tagline, address, language, time zone) | — (read directly, never a private option) |

**No grant reaches** deletion of anything, users, roles, plugins, themes, settings writes, API tokens,
MFA, backups or agent management. There is no vocabulary word for them, and the narrowed user answers
`false` for those capabilities.

### 2.1 Effective authority = grant ∩ user

Every tool call runs **as the bound user** with `req.user` replaced by a narrowed copy
(`backend/src/core/agent-capabilities.ts`, `narrowUser`) whose `can(cap)` is
`user.can(cap) && agentPermitsCapability(grant, cap)`. Consequences:

- A contributor's agent granted `content:publish` still cannot publish — the contributor cannot. The admin
  screen shows such a grant struck through as **inert**.
- An administrator's agent reports the synthetic role `agent` to role-based gates (`isAdmin`, the SVG
  upload rule), so it is never treated as an administrator.
- Content capabilities are classified from the registered post types' own policies (the same
  `capsForType` the REST content routes authorize with), so a custom type's `edit_books` behaves like
  `edit_posts` with no list to maintain. A capability this file does not classify is denied.

## 3. Tools

| Tool | Grant | Notes |
|---|---|---|
| `whoami` | — | the agent, the user it acts for, granted vs effective capabilities |
| `list_content`, `get_content` | `content:read` | `type`, `status`, `search`, paging; also resource `wordjs://content/{id}` |
| `list_terms`, `list_media` | `content:read` | |
| `create_draft` | `content:draft` | status is **always** `draft` |
| `update_draft` | `content:draft` | never changes status; editing live content needs `content:publish` |
| `submit_for_review` | `content:draft` | sets `pending` — how an agent *proposes* publication |
| `publish_content` | `content:publish` | answers `published`, `scheduled`, or — when the bound user may not publish that content and the site files it for review instead — `submittedForReview` with a notice; never "published" for something that did not go live |
| `create_term` | `taxonomy:write` | categories and tags |
| `upload_media` | `media:upload` | base64, ≤ 10 MB, optional title/caption/alt text |
| `list_comments`, `moderate_comment` | `comments:moderate` | approve or spam |
| `get_site_info` | `settings:read` | |

A tool is only **listed** when it is granted; calling an unlisted tool fails at the protocol level.

## 4. How it is wired

- **Endpoint**: `POST /api/v1/mcp` (`backend/src/routes/mcp.ts`), MCP **Streamable HTTP** transport via the
  official `@modelcontextprotocol/sdk`, **stateless** with JSON responses: every request authenticates on
  its own and gets a fresh server, so it works unchanged through the gateway, in monolith mode and on
  several nodes without sticky sessions. `GET`/`DELETE` answer `405`.
- **Credentials do not cross**: `/mcp` accepts only `Bearer wja_…`; the REST `authenticate` does not know
  the `wja_` prefix, so an agent token cannot drive the REST API directly. A `wjt_` API token or a session
  cookie is refused by `/mcp`.
- **Same rules as REST**: tools never call the models. They build a REST request and run it through the
  **same router** in-process (`backend/src/core/rest-dispatch.ts`). The dispatched request carries no
  credential; its identity lives in a `WeakMap` keyed by the request object, read at the top of
  `authenticate`/`optionalAuth`/`authenticateAllowQuery`. The grant's coarse REST scopes
  (`posts:write`, `media:write`, …) are enforced there as a second fence, and the request is marked
  headless, so every session-only route refuses it.
- **Agent management is session-only** (`/api/v1/agents`): an API token or an agent cannot create, grant
  or revoke agents. Only an administrator grants; the bound user or an administrator revokes; revocation is
  immediate and terminal. A password change/reset or account deletion revokes the user's connections.

## 5. Audit

Recorded in the append-only audit log, every row keyed `target_type = 'agent'`, `target_id = <connection
id>` so **Admin → AI agents → Audit trail** is one query:

- `agent.create`, `agent.grant` (`previous` and new grant), `agent.revoke`;
- `agent.write` — one row per write tool call, success or refusal: `{tool, objectType, objectId,
  httpStatus, ok, status}`. The REST handler the call ran through records its own row as well
  (`post.create`, `post.update`, …) under the bound user;
- `agent.denied` — a call to a tool the connection was not granted.

## 6. Prompt injection

Everything a tool returns was written by people. The server's `instructions` and every content-returning
tool say so, and results wrap site content under `data` with a notice. The guarantee does **not** depend on
the model behaving: authority comes only from the token's grant, which no tool can read-and-widen, and no
tool exists for users, roles, settings writes, plugins, themes, tokens or deletion. A hijacked agent can at
worst do what its grant allows — as a draft unless `content:publish` was granted — and every write leaves
an audit row.

## 7. Limits

- HTTP: 240 requests/minute per agent token (cluster-wide through the shared limiter store), on top of the
  global per-IP API limiter.
- Per agent, in-process: 120 tool calls/minute and 30 writes/minute.
- At most 25 live connections per bound user. Tool outputs clip long text fields.

## 8. Deploying

The endpoint lives under `/api`, which the gateway and the monolith already route to the backend in every
deploy mode, so nothing needs configuring. Behind a reverse proxy, make sure `Authorization` headers reach
the backend and that responses to `/api/v1/mcp` are not buffered or cached.
