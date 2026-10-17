# Tutorial 9 — Connect an AI agent to your site

WordJS has a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. Through
it, an AI assistant such as Claude Code, Claude Desktop or any MCP client can read your content and
write drafts for you, but only what an administrator allows. In this tutorial you connect an assistant
that can read the site and draft posts but cannot publish. You then watch what it does in the audit
trail and revoke it.

**Time:** about 10 minutes.
**You need:** a WordJS site and an administrator account, and an MCP-capable client. The commands
below use [Claude Code](https://docs.claude.com/en/docs/claude-code).

## 1. Request a connection

Open **Admin → AI agents**. Under **New connection**:

1. **Name:** `Claude Code — blog drafts`.
2. **Requested capabilities:** keep **Read content** and **Create and edit drafts**, which are ticked
   by default, and also tick **Read site identity**. Leave **Publish** unticked.
3. **Acts as:** **Myself**. The agent works as your user, and it can never do more than you can.
4. **Expires:** **Never**, or pick a date.

Click **Create connection**. A dialog shows the connection's token (`wja_…`) **once**, with ready-made
configuration for Claude Code and for `.mcp.json` files. Copy it now. You can't see the token again;
if you lose it, revoke the connection and create a new one.

## 2. Grant it

The connection starts **Pending**. A pending agent can connect, but the only tool it gets is `whoami`.
When you created it as an administrator, its review panel is already open under the connection:
*Tick what you grant*. Tick **Read content**, **Create and edit drafts** and **Read site identity**,
then click **Save grant**. The connection turns **Active**.

You can grant less than was requested, but never more. A grant never goes beyond the bound user's own
permissions either. For example, a contributor's agent granted **Publish** still can't publish, and
the screen shows that grant struck through.

## 3. Connect the client

Paste the Claude Code command from the dialog. It has this form:

```bash
claude mcp add --transport http wordjs https://<your-site>/api/v1/mcp --header "Authorization: Bearer wja_…"
```

For other clients, use the JSON from the dialog:

```json
{
  "mcpServers": {
    "wordjs": {
      "type": "http",
      "url": "https://<your-site>/api/v1/mcp",
      "headers": { "Authorization": "Bearer wja_…" }
    }
  }
}
```

The endpoint is part of the normal API, so it works in every deploy mode with nothing to configure.
Behind your own reverse proxy, make sure the `Authorization` header is passed through and that
`/api/v1/mcp` is not cached.

## 4. Put it to work

Ask the assistant something like:

> Look at my site's posts about pour-over coffee, then write a draft post called "Cold brew at home"
> in the same style.

With this grant it is offered these tools:

| Tool | What it does |
|---|---|
| `whoami` | Who the agent is, which user it acts for, and what it may do |
| `get_site_info` | The site's name, tagline, address, language and time zone |
| `list_content`, `get_content`, `list_terms`, `list_media` | Search and read entries, categories, tags and media |
| `create_draft`, `update_draft`, `submit_for_review` | Write drafts, edit them, and send them for review |

It finds *How we brew a pour-over* and creates *Cold brew at home* as a **draft**. Open
**Admin → Posts** to see the draft and publish it yourself if you like it. The agent has no
`publish_content` tool, because **Publish** was not granted. If it tries to call that tool anyway,
the call fails. Nothing it can do deletes content, or touches users, plugins, themes or settings.

Everything a tool returns is marked as content written by people, so the agent should treat it as
data, not instructions. The protection does not depend on the model behaving, though: the grant is
the limit.

## 5. See what it did, and revoke it

On the connection, **Audit trail** lists every event:

- `agent.create` and `agent.grant`, showing what was requested and what was granted;
- one `agent.write` row per write. For example: `tool=create_draft objectType=post objectId=25
  httpStatus=201 ok=true status=draft`.

To cut the agent off, click **Revoke** and confirm. It takes effect immediately: the next request with
that token gets `Invalid, expired or revoked agent token.` Revoking can't be undone. Changing or
resetting the user's password also revokes all of that user's connections.

## Good to know

- **Limits:** each token gets 240 requests a minute, 120 tool calls a minute and 30 writes a minute.
  Each user can have up to 25 live connections.
- **Other grants:** you can also grant **Publish**, **Upload media**, **Manage categories and tags**
  and **Moderate comments**. See [ai-agents.md](../ai-agents.md) for every capability and tool.
- **Without an assistant:** the dialog's token works with any MCP client library. The official
  TypeScript SDK's `StreamableHTTPClientTransport`, pointed at `/api/v1/mcp` with the `Authorization`
  header, is the same transport Claude Code uses.

---
*Tested on 2026-10-17 with WordJS 2.6.0 on a fresh install. The connection was created and granted in
a browser as above. The agent side was driven with the official MCP TypeScript SDK client (the
transport Claude Code uses) against the site's `/api/v1/mcp`:

- while pending, only `whoami` was offered, with empty grants;
- after the grant, `get_site_info`, a `list_content` search that found the imported pour-over post,
  and `create_draft` (post 25, status `draft`) all worked;
- `publish_content` was refused as an unknown tool;
- the audit trail showed the create, grant and write rows;
- after **Revoke**, the token got `401`.

`claude mcp add` with the dialog's command registered the server. A live Claude Code session was not
part of this run.*
