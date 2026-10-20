# Memberships and members-only content

WordJS gates content in two layers:

- **Core — content access levels** (`backend/src/core/content-access.ts`). A generic seam: an entry can
  require an *access level*, and every read surface serves a reader who does not hold that level the
  entry's **teaser** instead of its body. Core does not know what a member, a tier or a subscription is.
- **The `memberships` plugin** (`marketplace/plugins/memberships`). A bundled, sandboxed plugin that
  *provides* the levels: free and paid tiers, the paywall block, Stripe Checkout subscriptions verified by
  signed webhooks, tier changes and cancellation by the member, and complimentary memberships granted by
  an admin.

Any other plugin can be a provider too (a course plugin, an SSO bridge…): the seam is two filters.

---

## 1. The core seam: content access levels

### 1.1 What an entry stores

| Meta key | Value | Meaning |
| --- | --- | --- |
| `_wjs_access` | `''` / absent | Public (the default; nothing changes for existing content). |
| `_wjs_access` | a level slug, e.g. `members`, `paid`, `tier:gold` | Only readers holding that level read the full body. |

The post editor offers the field as **Acceso** in the entry's settings once a provider is active
(`GET /api/v1/content-access/levels`, `edit_posts`). The value is written through the normal `meta` bag,
under the same capability gate as every other author-written key.

A level that no active provider grants (a typo, a deleted tier, a deactivated plugin) **fails closed**:
the entry stays a teaser for everybody except the people who manage it.

### 1.2 Who reads the full body

1. Whoever **manages** the entry — its author with the type's edit capability, or an editor
   (`canManagePostRecord`). The editor loads through the same projection, so it always gets the full
   tree: a truncated tree saved back would destroy the body.
2. A signed-in reader whose **grants** include the level. Core asks the `content_access_grants` filter
   once per request per reader; anonymous readers hold nothing and the filter is never asked for them.

### 1.3 The teaser and the access break

The teaser is the part of the body **before the access break**:

- **HTML body** (`post_content`): an `<hr class="wjs-access-break">`. Verso writes it into the HTML
  fallback for any top-level block that declares the break (see below); an HTML comment would not survive
  the content sanitizer. No break → the body is withheld whole (the teaser is empty).
- **Verso tree** (`meta._puck_data`): the first top-level item whose props carry
  `contentAccessBreak: true`. Any block can be a break by putting that prop in its `defaultProps` — the
  memberships plugin's **Muro de pago** block does. The items before it are kept, the break item itself is
  kept (it draws the call-to-action) and annotated with `accessState: 'locked' | 'granted'` and
  `accessLevel`, and everything after it is removed — legacy `zones` included, except those owned by kept
  items. A break nested inside a container (a slot, or a legacy zone the container owns) cuts before that
  container and is lifted to the top level. No break → no items. A stored tree this rule cannot read (not
  `{ content: [...] }`, or JSON-encoded twice) is withheld whole. The root props stay (title, template,
  SEO) except `excerpt`, which the editor fills from the full body.
- **Excerpt**: the author's own excerpt, or one generated from the teaser — never from the body.
- **The level value**: a string. Any other stored value (`null`, `[]`, a number) gates with a level
  nobody holds, so a malformed value fails closed on every surface alike.

### 1.4 Every read surface

| Surface | Behaviour for a reader without the level |
| --- | --- |
| REST `GET /posts`, `/posts/:id`, `?slug=` (and GraphQL and the MCP tools, which dispatch REST) | Teaser `content`, teaser-derived `excerpt`, teaser `_puck_data`, and `access: { level, gated: true, granted: false }`. Public entries carry no `access` key. |
| `GET /posts/:id/meta` | The same teaser `_puck_data` (one projection for both routes). |
| Media (`/media`, `/media/:id`, `/posts?type=attachment`) | The files attached to a gated entry are listed and served by id only to who manages the entry, like a password-protected entry's. Members reach them through the body; the entry's featured image stays part of its teaser. Use private media for files that must not be downloadable by URL. |
| Public pages (SSR) | Rendered anonymously and cached (ISR), so the cached HTML only ever contains the teaser. `MembersOnlyGate` re-reads the entry in the browser of a signed-in visitor with their own session and swaps in the full body (and the comments) when the answer is `granted`. Signed-out visitors cause no request. |
| RSS / Atom / JSON feeds, category / tag / author feeds | The entry is listed; its summary is the author's excerpt or the teaser. |
| Search (`/posts?search=`) | A gated entry matches on its **title** only (no oracle on the withheld body), unless the searcher is its author or may edit others' entries. |
| Sitemaps | The URL is listed (its page is public and shows the teaser); sitemaps carry no body. |
| Comments (`/comments`, `/comments/:id`, `POST /comments`, the comments feed) | The comments of a gated entry are part of what the level unlocks: not listed, not fetchable, not writable (same 404 as a missing entry), not in the comments feed. |

`backend/src/tests/content-access-leaks.test.ts` checks every row above for an anonymous reader, a free
member and paid members, with managers as the positive control.

### 1.5 Provider contract (filters)

```js
// Levels the editor offers. value: Array<{ value, label }>
wordjs.hooks.addFilter('content_access_levels', async (levels) => [...levels, { value: 'members', label: 'Members' }]);

// Levels a signed-in account holds. value: string[]; ctx: { userId, role }
wordjs.hooks.addFilter('content_access_grants', async (grants, ctx) => [...grants, ...(await lookup(ctx.userId))]);
```

Level slugs match `^[a-z][a-z0-9:_-]{0,63}$` and are never `null`, `true` or `false`; anything else a
provider returns is dropped. Being a provider takes the explicit **`content_access:provider`** grant — what
the grants filter answers opens gated entries site-wide, so no other grant implies it — and the grants
filter also requires `users:read` (it identifies the reader). A provider that times out (2 s, like every
isolated hook) answers "nothing".

Responses to a signed-in reader (`/posts`, `/comments`, …) are sent `Cache-Control: private, no-cache` with
`Vary: Cookie, Authorization`, so a shared cache never keeps a member's full body for anyone else.

---

## 2. The `memberships` plugin

### 2.1 Members are the site's own accounts

Signing up is core's `/register` (with its e-mail verification, rate limits and MFA) and signing in is
core's session — a sandboxed plugin cannot hash passwords, and a second authentication stack would
duplicate every hardening the core one carries. With **free sign-up** on (the default), every signed-in
account is a free member (holds `members`); paid and complimentary memberships are rows in the plugin's
own `wjp_memberships_members` table, keyed by user id. Turn on *Anyone can register* in Settings → General
for the sign-up button to work; the login and sign-up pages honour `?redirect=<same-origin path>`, so a
reader comes back to the post.

### 2.2 Levels

| Level | Held by |
| --- | --- |
| `members` | Every signed-in account (free sign-up on), or any live membership. |
| `paid` | Any live paid or complimentary membership on a paid tier. |
| `tier:<slug>` | That tier **or a dearer one** (`Gold` opens content for `Silver`). Tier slugs are immutable for that reason. |

A Stripe membership grants access while it is `active` or `past_due` (Stripe is still retrying the
renewal); a membership whose paid period ended more than 3 days ago without a renewal stops granting even
if a webhook was missed. A complimentary membership grants until its optional end date.

### 2.3 Blocks

- **Muro de pago (miembros)** — the access break. In the editor it is a visible marker; on a locked page it
  draws the call-to-action (create an account, sign in, the tiers that open the post, Stripe Checkout); on
  a granted page it draws nothing.
- **Mi membresía** — the member's account box: plan, status, renewal or end date, change to another tier,
  cancel at period end / keep subscribing.

### 2.4 Stripe (test mode only in this version)

Settings (admin → Membresías → Ajustes): the secret key — **test keys only** (`sk_test_…`/`rk_test_…`;
live keys are refused until the live flow has been verified end to end) — and the webhook signing secret
(`whsec_…`). Both are stored in the plugin's own settings table, write-only, never echoed back.

- **Checkout**: `POST /api/v1/plugin/memberships/checkout { tier_id }` creates a Checkout Session in
  `subscription` mode. The price is the tier row's (a Stripe product per tier is created on first use); the
  success URL keeps only the path of the page on this site; the session carries the account and tier in
  its metadata and is recorded against the account.
- **Return leg**: the success URL carries `?ms_session=<id>`; the block calls `/me/confirm`, which
  retrieves the session server-side and refuses a session started by another account. Activation is
  idempotent and shared with the webhook.
- **Webhook**: `POST /api/v1/plugin/memberships/stripe/webhook` (a core `{ webhook: true }` route, §3).
  The `Stripe-Signature` header is verified with HMAC-SHA256 over the raw body within a 5-minute
  tolerance; any of several `v1` signatures may match (secret rotation); each event id is applied once;
  live-mode events are refused. Handled events: `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`.
- **Change tier**: the subscription's item moves to the new tier's price with prorations. **Cancel** sets
  `cancel_at_period_end` (access continues to the end of the period); **resume** clears it.

Local testing with the Stripe CLI:

```bash
stripe listen --forward-to http://localhost:3000/api/v1/plugin/memberships/stripe/webhook
```

Paste the `whsec_…` it prints into Ajustes, and pay with Stripe's published test cards
(`4242 4242 4242 4242`, any future date, any CVC).

### 2.5 Complimentary memberships

Admin → Membresías → Miembros: grant a tier to an existing account (by e-mail or login), optionally until
a date; revoke ends it at once (a paid membership is cancelled at Stripe immediately).

### 2.6 Newsletters

Publishing a post can email it to members, Ghost-style (`lib/newsletter.js`):

- **Choosing.** The post editor shows **Enviar por correo al publicar** (No / all members / free members /
  paid members). It is a core *editor field* the plugin declares (§4); the value is the post meta
  `newsletter_audience`. Admins can also send an already published post from Membresías → Newsletter.
- **Queued, never inline.** The publish request only writes a trigger row (from the `wp_insert_post` /
  `post_updated` hooks, on the transition into `publish`). A queue worker in the plugin's isolate — every
  few seconds, or *Procesar la cola ahora* in the admin — reads the post through the posts bridge, builds
  the recipient list and sends at most **N mails per minute** (Ajustes, default 60) through `wordjs.mail`,
  i.e. the site's mail provider plugin (`mail-server`): there is no transport of its own. A failed mail is
  retried after 1 and 2 more minutes, then counted as failed; the admin can retry failed deliveries.
- **Only confirmed addresses.** An account's e-mail is whatever was typed at sign-up, which proves nothing
  when the site does not require e-mail verification. A newsletter goes only to an address **confirmed for
  that account** (the member clicked a link mailed to exactly that address — the portal page with
  `&c=<token>`, an HMAC of the account and the address). A subscribed member whose address is not confirmed
  gets, instead of the newsletter, one fixed-text confirmation mail at most every 30 days, and can ask for
  the link from the account block (once a day); changing the address un-confirms it. Nothing a visitor
  writes is ever in that mail.
- **Who receives what.** `all` = every subscribed member with a confirmed address; `free` = members without
  a paid level; `paid` = members with one. For a post that requires an access level, only members who
  **hold that level** get the full body; everyone else gets the **teaser** (the body before the access
  break, or the author's own excerpt when there is none — never an excerpt derived from the body) plus
  *Leer en el sitio*. This is decided **when each mail is sent**, not when the list is built: a post gated
  after its send started goes out as a teaser to the rest, and an address that unsubscribed or changed in
  the meantime is skipped. Site-relative links and images are made absolute; shortcodes are dropped; the
  subject is one line.
- **Once, even with several workers.** Each step is claimed in the database before it is done — a trigger
  by deleting it, a send by leaving `queued`, a delivery by moving to `sending` — so the timer, the admin's
  button and a second server never mail the same delivery twice; a delivery whose run died is retried after
  15 minutes. One newsletter per post is a unique key, so a double click cannot create two sends (a
  discarded send frees it).
- **Who may send.** Any author can set a meta value, so a post written by an administrator or editor is
  queued at once, while any other author's request waits in the send log for an admin to approve or
  discard it. Each post is emailed once.
- **Unsubscribe.** Every mail ends with a one-click link to `/portal/memberships?u=<id>&t=<token>` (the
  plugin's portal page); the token is an HMAC of the account id under a per-install secret, so it works for
  that account only. The page unsubscribes on open and offers to subscribe again; members can also switch
  newsletters on and off in the **Mi membresía** block. Every mail also carries the RFC 8058 headers
  `List-Unsubscribe: <…/api/v1/plugin/memberships/public/newsletter/one-click?u=…&t=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so mail clients offer an unsubscribe button that
  works without opening anything (a core webhook route: no session, CSRF-exempt, the token is the proof).
  The `mail-server` plugin sends them; another mail provider may drop caller headers, and the link in the
  body still works. Default: subscribed (once confirmed).
- **Admin.** Membresías → Newsletter: send log with status and delivered / failed counts (failed
  addresses with the error), approve / discard, retry failed, a **test send** (as a member with or without
  access receives it) and sending an already published post.

Without a mail provider nothing is delivered: every delivery fails with the provider's error and shows up
in the log.

### 2.7 Outside this version

- Stripe **live mode**, the Stripe customer portal, coupons/trials, and per-member analytics.
- Newsletter open/click tracking and a separate (non-post) campaign editor.

---

## 3. Plugin webhook routes and the HMAC bridge (generic)

Two core additions any plugin can use, introduced for the Stripe webhook:

- `wordjs.http.route('post', '/hook', { webhook: true }, handler)` — a signed server-to-server webhook.
  The route is exempt from the CSRF gate (a provider sends no `Origin`/`Referer`) and receives
  `req.rawBody` (the body exactly as received) and the provider's signature headers; in exchange it never
  carries an identity: `req.user` is `null`, no cookies are forwarded, and it cannot be combined with
  `auth`, `admin` or `multipart` (such a registration is refused). POST only.
- `await wordjs.crypto.hmac(algorithm, key, data, encoding?)` (`sha256`/`sha1`/`sha512`, hex or base64,
  data ≤ 2 MB) and `await wordjs.crypto.timingSafeEqual(a, b)` — keyed hashing for signature checks; the
  static validator keeps `require('crypto')` out of plugin code.

See `backend/src/core/plugin-webhooks.ts` and `backend/src/tests/plugin-webhook-routes.test.ts`.

## 4. Post editor fields and the posts bridge (generic)

- **Editor fields** (`backend/src/core/editor-fields.ts`, `GET /api/v1/editor/fields?type=post`): a plugin
  declares fields for the post editor's settings through the `post_editor_fields` filter — data, not code:
  `{ metaKey, label, type: 'select' | 'radio' | 'text', options?, help?, postTypes? }`. Core validates the
  declaration (an unprefixed meta key that is not one of core's own, bounded options), renders it, seeds it
  from the entry's meta and saves it through the normal `meta` bag only when the author changed it. A
  plugin acting on the value must apply its own policy on *who* may trigger what.
- **`wordjs.posts.get(id)`** (grant `posts:read`): a PUBLISHED, public, unprotected entry — title, public
  path and URL, author id, the author's own excerpt, the full `content`, its `accessLevel` and its
  unprefixed meta; `null` for anything else. A plugin that sends or syndicates content must withhold the
  gated part itself from recipients who do not hold the level.
- **`wordjs.users.search(term, limit, offset)`**: `offset` pages through every account (ordered by id).
