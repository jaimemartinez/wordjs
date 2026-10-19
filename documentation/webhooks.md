# Outgoing webhooks — event catalogue and payloads

WordJS POSTs a signed JSON body to every registered endpoint whose subscription matches an event. This page
is the reference for **what** is sent; managing endpoints is covered in [api.md §6.10](api.md#610-outgoing-webhooks-),
and the delivery machinery (queue, retries, SSRF guard) in [core-modules.md §9c](core-modules.md#9c-outgoing-webhooks-).

Source of truth: the catalogue is `WEBHOOK_EVENT_GROUPS` in `backend/src/models/Webhook.ts` (served by
`GET /api/v1/webhooks/events`), and every payload is built by an allowlisted serializer in
`backend/src/core/webhook-payloads.ts`.

## The envelope

Every delivery has the same shape:

```json
{
  "event": "post.published",
  "eventId": "c0a8…",
  "timestamp": 1760540000,
  "actor": 1,
  "data": { }
}
```

| Field       | Meaning |
| :---------- | :------ |
| `event`     | The event name (also in the `X-WordJS-Event` header). |
| `eventId`   | Present on post events: the id of the content-outbox event that produced it. A replayed hook carries the same id, and the queue keeps one delivery per endpoint + `eventId` + `event`, so it is safe to de-duplicate on. |
| `timestamp` | Unix seconds when the delivery was queued (the signing timestamp is the `X-WordJS-Timestamp` header). |
| `actor`     | The id of the user who caused the event, when it is known (every event derived from the audit trail, and `ping`). Absent for post and plugin/theme hook events. |
| `data`      | The entity, as described per event below. |

Headers: `Content-Type: application/json`, `User-Agent: WordJS-Webhook/1.0`, `X-WordJS-Event`,
`X-WordJS-Delivery` (the delivery id — also stable across retries of that delivery), `X-WordJS-Timestamp`
and `X-WordJS-Signature-256`.

### Verifying the signature

`X-WordJS-Signature-256` is `sha256=` followed by the hex HMAC-SHA256 of `"<X-WordJS-Timestamp>.<raw body>"`,
keyed with the endpoint's signing secret (`whsec_…`, shown once at creation or rotation). Recompute it over the
**raw** bytes before parsing, compare in constant time, and reject stale timestamps:

```js
const crypto = require('crypto');
function verify(secret, headers, rawBody, toleranceSec = 300) {
  const ts = Number(headers['x-wordjs-timestamp']);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const got = String(headers['x-wordjs-signature-256'] || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
```

Answer with any `2xx` to acknowledge. Anything else (or no answer within 10 s) is retried with exponential
backoff — 6 attempts in all — and an endpoint that fails 20 times in a row is paused.

## Subscribing

`events` on a webhook is a list of exact names, family wildcards (`post.*`, `user.*`, …) or `*` for
everything. An absent or empty list means `*`.

**Opt-in events** are delivered only to an endpoint that names them exactly; no wildcard includes them.
Today there is one: `user.login` (high-volume and personal, so an endpoint registered for "everything" does
not start receiving every sign-in). `GET /webhooks/events` lists them under `optIn`.

The stored format did not change when the catalogue grew: a webhook subscribed to `*` or `post.*` before now
simply receives the new events of that scope (except opt-in ones).

## What is never sent

Payloads are built field by field; nothing is spread from a database row or a model. The following never
appear in any body: password hashes or passwords, MFA secrets and backup codes, API or session tokens,
signing secrets, user email addresses, commenter email / IP / user agent, sign-in IP addresses, option
**values** (and secret-named or protected option names), and the download URL of a private media item.
`backend/src/tests/webhook-events.test.ts` ("payload redaction") pins this.

## Events

### Posts and pages — `post.*`

Fired from the content hooks (`wp_insert_post`, `post_updated`, `deleted_post`), so they cover every writer:
the REST API, the editor, imports, scheduled publishing, revision restores and plugins. Pages and custom
post types use the same events; `data.type` tells them apart. Revisions, attachments and menu items never
fire post events.

`data` (the post serializer):

```json
{ "id": 42, "type": "post", "status": "publish", "title": "Hello", "slug": "hello",
  "author": 1, "date": "2026-10-15 10:00:00", "modified": "2026-10-15 10:05:00" }
```

| Event              | When | Extra fields |
| :----------------- | :--- | :----------- |
| `post.created`     | A post is inserted (any status). | — |
| `post.published`   | A post becomes `publish` (on insert, or a transition from any other status). | — |
| `post.updated`     | Any save of a post that is not being trashed. | — |
| `post.scheduled`   | A post becomes `future` (inserted as, or moved to, scheduled). | — |
| `post.unpublished` | A published post moves to any other status except `trash` (draft, pending, private, future). | `previousStatus` |
| `post.trashed`     | A post moves to the trash. | `previousStatus` |
| `post.restored`    | A post leaves the trash (`post.updated` fires first, as for any save). | — |
| `post.deleted`     | The post is permanently deleted (`data` is `{ "id" }` only), **or** moved to the trash — the original soft-delete signal, kept so receivers written before `post.trashed` keep working. A permanent delete of an already-trashed post does not fire it again. | — |

One save can produce several events, always in this order: `post.trashed` → `post.deleted`; or
`post.updated` → `post.restored` → `post.published` → `post.scheduled` → `post.unpublished`.

### Comments — `comment.*`

`data` (the comment serializer; never the commenter's email, IP or user agent):

```json
{ "id": 7, "postId": 42, "author": "Ana", "content": "Great post", "approved": "1",
  "userId": 0, "parent": 0, "date": "2026-10-15 10:00:00" }
```

`approved` is the stored status: `"1"` approved, `"0"` pending, `"spam"`, `"trash"`.

| Event              | When | Extra fields |
| :----------------- | :--- | :----------- |
| `comment.created`  | A comment is stored (any status, including pending). | — |
| `comment.approved` | A moderator approves it (`POST /comments/:id/approve`, or `PUT` with `status: "1"`). | `previousStatus` |
| `comment.updated`  | A moderator edits it, or moves it back to pending. | `previousStatus` |
| `comment.spam`     | Marked as spam. | `previousStatus` |
| `comment.trashed`  | Moved to the trash (`DELETE /comments/:id`). | `previousStatus` |
| `comment.deleted`  | Permanently deleted (`?force=true`). `data` is `{ "id" }` only. | — |

### Users — `user.*`

`data` (the user serializer — identity and role only; never the email, password hash or any user meta):

```json
{ "id": 5, "username": "ana", "displayName": "Ana", "slug": "ana", "role": "editor",
  "registered": "2026-10-15 10:00:00" }
```

| Event          | When | Extra fields |
| :------------- | :--- | :----------- |
| `user.created` | An administrator creates an account, or a visitor's self-registration creates one. | `via: "register"` for a self-registration |
| `user.updated` | A profile save (`PUT /users/me`, `PUT /users/:id`), including a role change. One event per save. | `changed`: the field names the save wrote (e.g. `["displayName","role"]`) — never values. A password change is not listed. |
| `user.deleted` | An account is deleted. | `data` is `{ "id", "username", "role" }` (the account no longer exists) |
| `user.login`   | **Opt-in.** A successful sign-in. | — (the sign-in IP is not sent) |

### Media — `media.*`

`data` (the media serializer):

```json
{ "id": 9, "title": "Banner", "mimeType": "image/png", "visibility": "public",
  "url": "https://example.com/uploads/2026/10/banner.png", "alt": "", "caption": "",
  "author": 1, "parent": 0, "width": 1200, "height": 630, "filesize": 48211,
  "date": "2026-10-15 10:00:00", "modified": "2026-10-15 10:00:00" }
```

A private item (`visibility: "private"`) is announced with `url: null`.

| Event            | When | Extra fields |
| :--------------- | :--- | :----------- |
| `media.uploaded` | A file is uploaded to the library. | — |
| `media.updated`  | Its title, description, caption, alt text or visibility is edited. | `changed`: the field names written |
| `media.deleted`  | It is deleted (with its files). | `data` is `{ "id", "title", "mimeType", "visibility" }` |

### Taxonomy terms — `term.*`

`data`: `{ "id", "name", "slug", "taxonomy", "parent", "description" }` — `taxonomy` is `category` or `post_tag`.

| Event          | When |
| :------------- | :--- |
| `term.created` | A category or tag is created through `/categories` or `/tags`. |
| `term.updated` | It is edited. |
| `term.deleted` | It is deleted. `data` carries its last `id`, `name`, `slug` and `taxonomy`. |

### Menus — `menu.updated`

One event for every change to a navigation menu. `data`:

```json
{ "id": 3, "name": "Main", "slug": "main", "change": "item_added", "itemId": 17 }
```

`change` is one of `created`, `renamed`, `deleted`, `location` (with `location`: the theme location it was
assigned to), `item_added`, `item_updated`, `item_deleted` (the three item changes carry `itemId`).

### Plugins and themes — `plugin.*`, `theme.activated`

| Event                | When | `data` |
| :------------------- | :--- | :----- |
| `plugin.installed`   | A plugin is installed from an uploaded zip or the marketplace (a failed install sends nothing). | `{ "slug", "via": "upload" }` or `{ "slug", "via": "marketplace", "source", "version" }` |
| `plugin.activated`   | A plugin is activated. | `{ "slug" }` |
| `plugin.deactivated` | A plugin is deactivated. An in-place update briefly deactivates and reactivates the plugin, so it produces a `plugin.deactivated` / `plugin.activated` pair. | `{ "slug" }` |
| `plugin.uninstalled` | A plugin is deleted. | `{ "slug" }` |
| `theme.activated`    | The active theme changes. | `{ "slug", "previous" }` |

### Settings — `settings.updated`

A save of the general settings (`PUT /settings`). `data` is `{ "keys": ["blogname", "blogdescription"] }` —
the names of the options it wrote, **never their values**; secret-named and protected option names are left
out, and a save that wrote nothing else sends nothing.

### `ping`

Not subscribable. Sent only by **Send test** in the admin (`POST /api/v1/webhooks/:id/ping`) to that one
endpoint, whatever its subscriptions, through the same signing, SSRF guard and delivery log as a real event:

```json
{ "event": "ping", "timestamp": 1760540000, "actor": 1,
  "data": { "webhookId": 4, "message": "Test delivery from WordJS. If this signature verifies, the endpoint is set up correctly." } }
```

## Where the events come from

The dispatcher (`backend/src/core/webhooks.ts`) has no emit calls of its own scattered through the code. It
listens to two seams that already mark these moments:

- **Action hooks** core fires anyway: `wp_insert_post`, `post_updated`, `deleted_post`, `wp_insert_comment`,
  `deleted_comment`, `activated_plugin`, `deactivated_plugin`, `switch_theme`.
- **The audit trail** (`backend/src/core/audit.ts`): `onAuditRecorded()` is a host-only, in-process observer of
  every `recordAudit()` call. User, sign-in, comment-moderation, media, term, menu, plugin install/uninstall and
  settings events are derived from those rows, after the mutation's transaction commits. Adding an event for
  another audited action is a line in `AUDIT_EVENT_MAP` plus a serializer.

Listeners only enqueue a durable delivery row and return; the HTTP request happens out of band, so a slow or
failing receiver never slows down or fails the write that caused the event.
