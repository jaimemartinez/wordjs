# Memberships and members-only content

WordJS gates content in two layers:

- **Core — content access levels** (`backend/src/core/content-access.ts`). A generic seam: an entry can
  require an *access level*, and every read surface serves a reader who does not hold that level the
  entry's **teaser** instead of its body. Core does not know what a member, a tier or a subscription is.
- **The `memberships` plugin** (`marketplace/plugins/memberships`). A bundled, sandboxed plugin that
  *provides* the levels: free and paid tiers, the paywall block, paid memberships through Stripe, Mercado
  Pago or Wompi verified by signed webhooks, tier changes and cancellation by the member, and complimentary memberships granted by
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
  items. A break nested inside a container cuts before that container and is lifted to the top level.
  No break → no items.
- **Excerpt**: the author's own excerpt, or one generated from the teaser — never from the body.

### 1.4 Every read surface

| Surface | Behaviour for a reader without the level |
| --- | --- |
| REST `GET /posts`, `/posts/:id`, `?slug=` (and GraphQL, which dispatches REST) | Teaser `content`, teaser-derived `excerpt`, teaser `_puck_data`, and `access: { level, gated: true, granted: false }`. Public entries carry no `access` key. |
| Public pages (SSR) | Rendered anonymously and cached (ISR), so the cached HTML only ever contains the teaser. `MembersOnlyGate` re-reads the entry in the browser of a signed-in visitor with their own session and swaps in the full body (and the comments) when the answer is `granted`. Signed-out visitors cause no request. |
| RSS / Atom / JSON feeds, category / tag / author feeds | The entry is listed; its summary is the author's excerpt or the teaser. |
| Search (`/posts?search=`) | A gated entry matches on its **title** only (no oracle on the withheld body), unless the searcher is its author or may edit others' entries. |
| Sitemaps | The URL is listed (its page is public and shows the teaser); sitemaps carry no body. |
| Comments (`/comments`, `/comments/:id`, `POST /comments`, the comments feed) | The comments of a gated entry are part of what the level unlocks: not listed, not fetchable, not writable (same 404 as a missing entry), not in the comments feed. |

`backend/src/tests/content-access-leaks.test.ts` checks every row above for an anonymous reader, a free
member and paid members (including a membership from each payment provider in every state), with
managers as the positive control.

### 1.5 Provider contract (filters)

```js
// Levels the editor offers. value: Array<{ value, label }>
wordjs.hooks.addFilter('content_access_levels', async (levels) => [...levels, { value: 'members', label: 'Members' }]);

// Levels a signed-in account holds. value: string[]; ctx: { userId, role }
wordjs.hooks.addFilter('content_access_grants', async (grants, ctx) => [...grants, ...(await lookup(ctx.userId))]);
```

Level slugs match `^[a-z0-9][a-z0-9:_-]{0,63}$`; anything else a provider returns is dropped. Subscribing
to `content_access_grants` requires the `users:read` grant (it identifies the reader); the levels filter
is public. A provider that times out (2 s, like every isolated hook) answers "nothing".

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
| `tier:<slug>` | That tier **or a dearer one** (`Gold` opens content for `Silver`), ranked by price **per month** (a yearly price counts as twelve months: a 50/year plan is below a 20/month one). Tier slugs are immutable. |

A paid membership grants access while it is `active`, and while it is `past_due` (the provider is still
collecting a failed payment) for **3 days from the moment it became past due** — not for the new period
the provider has already opened. A membership whose paid period ended more than 3 days ago without a
renewal stops granting even if a webhook was missed; a Wompi period paid without automatic renewal has no
such grace (there is nothing left to collect). A complimentary membership grants until its optional end
date.

### 2.3 Blocks

- **Muro de pago (miembros)** — the access break. In the editor it is a visible marker; on a locked page it
  draws the call-to-action (create an account, sign in, the tiers that open the post, the provider's checkout); on
  a granted page it draws nothing.
- **Mi membresía** — the member's account box: plan, status, renewal or end date, change to another tier,
  cancel at period end / keep subscribing; with Wompi, pay the next period and turn automatic
  renewal with Nequi on or off.

### 2.4 Payments: one provider interface, three providers

Admin → Membresías → Ajustes → **Proveedor de pagos** picks who takes the money: **Stripe**, **Mercado
Pago** or **Wompi** (or none). Every provider implements the same interface
(`lib/providers/index.js`) — checkout for a tier, the return leg, a verified webhook applied once, change
tier, cancel / resume, admin revoke — and writes memberships through one store function, so the access
rules (§2.2) are the same whichever one took the money. Provider statuses map to `active`, `past_due`,
`incomplete`, `canceled` and `expired`; the provider's ids are kept in `provider_customer_id`,
`provider_subscription_id` and `provider_payment_source`.

**Sandbox / test credentials only in this version.** Each provider refuses live credentials (by their
format, and for Mercado Pago by asking the API, see below) and live events. Credentials are stored in the
plugin's own settings table, write-only: the admin shows whether each one is set, never its value. The
Ajustes tab shows each provider's webhook URL.

The plugin needs the `network` grant to reach the provider. Narrow it with the plugin's **egress host
allowlist** (`POST /api/v1/plugins/memberships/egress-hosts`, see plugins.md) to the provider you use:
`api.stripe.com`, `api.mercadopago.com` or `sandbox.wompi.co`.

Money is integer minor units throughout (COP 20.000 is `2000000`); the price always comes from the tier
row, never from the client. The site currency (Ajustes) is what the provider charges in.

| | Stripe | Mercado Pago | Wompi |
| --- | --- | --- | --- |
| Recurring model | Stripe subscription (Checkout, `subscription` mode) | Preapproval subscription (Mercado Pago charges every period) | No subscriptions at Wompi: each payment opens a prepaid period; automatic renewal with a Nequi payment source, charged by this site |
| Payment methods | Stripe's | Mercado Pago's (cards, account balance) | Web Checkout: cards, PSE, Nequi, Bancolombia… Renewal: Nequi |
| Currency | Any Stripe supports | The account's (COP in Colombia) | COP only |
| Webhook | `/api/v1/plugin/memberships/stripe/webhook` | `/api/v1/plugin/memberships/mercadopago/webhook` | `/api/v1/plugin/memberships/wompi/webhook` |
| Verification | `Stripe-Signature` (HMAC-SHA256, 5 min) | `x-signature` (HMAC-SHA256, 1 h) | `signature.checksum` (SHA-256 with the events secret, 26 h) + `X-Event-Checksum` |
| Idempotency key | event id | `x-request-id` | transaction id + status |
| Change tier | Once the prorated difference is paid (invoiced at once) | From the next approved charge (new amount) | From the next paid period |
| Refund / void | A full refund or a dispute ends the membership at once | Re-read from the API (a cancelled preapproval ends it) | A voided payment takes its period back |
| Cancel | At period end (`cancel_at_period_end`) | Preapproval `paused` (no more charges); access to the period end | No renewal; access to the period end |

A member with a live paid membership cannot start a second one (with the same or another provider);
only Wompi takes another payment while a period runs — it prepays the next period. Starting a checkout
retires the account's earlier unpaid ones at the provider (Stripe sessions are expired, Mercado Pago
preapprovals that were never authorised are cancelled), and a second request from the same account while
one is being prepared is refused, so a double click or two tabs cannot leave two subscriptions billing.
The return URL is always a page of this site (a `//host` path is collapsed). A paid membership whose
period (plus 3 days of grace) is over and that nothing renewed is marked `expired` by the plugin's payments
job (every 10 minutes, or `POST /payments/process` as an admin).

#### 2.4.1 Stripe

Settings: the secret key — **test keys only** (`sk_test_…`/`rk_test_…`) — and the webhook signing secret
(`whsec_…`).

- **Checkout**: `POST /api/v1/plugin/memberships/checkout { tier_id }` creates a Checkout Session in
  `subscription` mode. The price is the tier row's (a Stripe product per tier is created on first use); the
  success URL keeps only the path of the page on this site; the session carries the account and tier in
  its metadata and is recorded against the account.
- **Return leg**: the success URL carries `?ms_session=<id>`; the block calls `/me/confirm`, which
  retrieves the session server-side and refuses a session started by another account. Activation is
  idempotent and shared with the webhook.
- **Webhook**: the `Stripe-Signature` header is verified with HMAC-SHA256 over the raw body within a
  5-minute tolerance; any of several `v1` signatures may match (secret rotation); each event id is applied
  once; live-mode events are refused. Handled events: `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`,
  `charge.refunded`, `charge.dispute.created`. The event only says WHAT changed: the session or
  subscription it names is **re-read from the API** and that state is applied, so a late, retried or
  out-of-order event can only apply the current state. On top of that, an event older than the newest one
  applied to the membership changes nothing, a canceled subscription never becomes active again, and an
  event about a subscription the account no longer pays with never touches the one it pays with now. The
  tier is the one whose Stripe product the subscription bills.
- **Refunds and disputes**: a **full** refund (`charge.refunded` with `refunded: true`) or a dispute ends
  the membership of that customer at once — its subscription is deleted at Stripe so it is not charged
  again. A partial refund changes nothing.
- **Amounts**: tiers store integer cents (units × 100); Stripe takes each currency's own minor unit, so a
  zero-decimal currency (JPY, CLP, KRW…) is sent divided by 100 and a three-decimal one (KWD, BHD…)
  multiplied by 10 — ¥500 is charged as ¥500.
- **Change tier**: the subscription's item moves to the new tier's price and the prorated difference is
  **invoiced at once**; the item moves only when that invoice is paid (`payment_behavior:
  pending_if_incomplete`), so an upgrade is never read before it is paid for — the account box shows the
  new plan as pending until then. A downgrade leaves a credit for the next invoice. **Cancel** sets
  `cancel_at_period_end` (access continues to the end of the period); **resume** clears it. If the account
  manages to pay a second subscription anyway, the older one is deleted with proration (its unused part
  becomes a credit the new one uses).

Sandbox keys: Stripe Dashboard → *Developers* → *API keys*, with **Test mode** on. Webhook: *Developers* →
*Webhooks* → *Add endpoint* with the URL above and the five events; its *Signing secret* is the `whsec_…`.
Locally, the Stripe CLI forwards events instead:

```bash
stripe listen --forward-to http://localhost:3000/api/v1/plugin/memberships/stripe/webhook
```

Pay with Stripe's published test cards (`4242 4242 4242 4242`, any future date, any CVC).

#### 2.4.2 Mercado Pago

Settings: the **access token** and the **webhook secret key**.

- **Checkout**: creates a preapproval (*subscription without an associated plan*, `POST /preapproval`)
  with `status: pending`, the tier's amount (`transaction_amount` = price / 100, a whole number for
  currencies without cents such as COP and CLP), the site currency
  (`currency_id`, e.g. `COP`), every 1 month (or 12 for a yearly tier), the member's e-mail as
  `payer_email`, and a `back_url` on this site; the member authorizes it on Mercado Pago's page
  (`init_point`).
- **Return leg**: Mercado Pago returns to `back_url?preapproval_id=…`; the block calls `/me/confirm`, which
  checks that this account started that preapproval and re-reads it from the API.
- **Webhook**: the `x-signature` header (`ts=…,v1=…`) is an HMAC-SHA256, with the webhook secret, of
  `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (`data.id` lowercased when alphanumeric); a
  notification older than 1 hour is refused, each `x-request-id` is processed once, and `live_mode`
  notifications are refused. The plugin never trusts the body: it re-reads the preapproval (topic
  `subscription_preapproval`) or the recurring charge (`subscription_authorized_payment`, then its
  preapproval). Status mapping: `authorized` → active; `paused` → active until the period end, not
  renewing; `pending` → incomplete; `cancelled` → canceled. A rejected or retried charge makes the
  membership `past_due` (access kept for 3 days while Mercado Pago retries); an approved one makes it
  active again. A preapproval whose amount or currency is not the one this plugin set opens nothing.
- **Change tier**: the preapproval's amount is updated; Mercado Pago charges it from the next charge, and
  the new tier is granted when that charge is approved (the account box shows it as pending until then).
  **Cancel** pauses the preapproval, **resume** authorizes it again, an admin **revoke** cancels it.
- One-off payments (Checkout Pro) are not used: every tier is recurring.

Sandbox credentials: <https://www.mercadopago.com.co/developers/panel/app> → create an application (or open
yours) → **Credenciales de prueba** → *Access Token* (`TEST-…`). Mercado Pago recommends testing
subscriptions with **test users** instead (*Cuentas de prueba*: create a seller and a buyer); the seller's
*production* credentials are then an `APP_USR-…` token. Because `APP_USR-` is also the format of real
production tokens, the plugin only accepts one after `GET /users/me` says the account is a test user
(`tags` contains `test_user`); a real account's token is refused. Pay as the buyer test user: the member's
e-mail on this site must be the buyer test user's e-mail, and the card one of Mercado Pago's published
test cards (cardholder name `APRO` for an approved payment).

Webhook: the same application → **Webhooks** → *Configurar notificaciones* → **Modo de prueba**: paste
the URL above, tick **Planes y suscripciones** (`subscription_preapproval`,
`subscription_authorized_payment`), save, and copy the **clave secreta** shown there into Ajustes.

#### 2.4.3 Wompi

Settings: the **public key** (`pub_test_…`), the **private key** (`prv_test_…`), the **events secret**
(`test_events_…`) and the **integrity secret** (`test_integrity_…`). The site currency must be **COP**.

Wompi has no subscriptions, so the recurring model is stated here plainly:

- **A payment buys one period.** The checkout sends the member to Wompi's Web Checkout
  (`checkout.wompi.co/p/`) with the tier's amount in COP cents, a unique reference and the
  **integrity signature** (SHA-256 of reference + amount + currency + integrity secret), so the amount
  cannot be changed in the browser. The member pays with whatever the merchant has enabled — card, PSE,
  Nequi, Bancolombia. An approved transaction opens one period of the tier (1 month or 1 year).
- **Paying again prepays the next period** (it is added to the running one); the account block offers
  *Pagar el siguiente periodo*.
- **Automatic renewal is opt-in, with Nequi.** In the account block the member enters their Nequi number
  and approves the request in the Nequi app; the plugin turns the approved token into a Wompi **payment
  source** and its payments job charges it (`POST /transactions` with `payment_source_id`, signed) a day
  before the period ends. Each renewal is **claimed** before it is charged — its reference names the
  account, the period and the attempt, and is unique — so the timer, the admin's *process now* and a second
  server cannot charge the same period twice; a charge whose result has not arrived is asked about
  (`GET /transactions/{id}`, or by reference), never made again. A declined renewal makes the membership
  `past_due` (access kept for 3 days) and is retried daily; after 3 declines the membership is canceled.
  Wompi is only offered once all four credentials, the events secret included, are set. Card payment
  sources are not offered: tokenizing a
  card would put card numbers through this site's pages (PCI scope); a member paying by card pays each
  period, like PSE.
- **Return leg**: Web Checkout returns to the page with `?id=<transaction>`; `/me/confirm` re-reads the
  transaction from the API and applies it only if its reference is one this account started, and the
  amount and currency match.
- **Events**: `transaction.updated` and `nequi_token.updated`. The checksum is SHA-256 of the values of
  `signature.properties` (read from `data`), then `timestamp`, then the events secret; it must match
  `signature.checksum` and the `X-Event-Checksum` header when present, the event must be at most 26 hours
  old (Wompi retries for 24) and `environment` must be `test`. The signed properties must include the
  transaction's id, status and amount; the transaction is then **re-read from the API** by its id and that
  is what is applied (the event's other fields are not signed). Each transaction id + status is applied
  once, and the return leg and the event for the same payment extend the period once. A **voided**
  transaction that had opened a period takes that period back.
- **Change tier**: from the next paid period (the next renewal or payment charges the new tier).
  **Cancel**: no automatic renewal; access to the end of the period. An admin **revoke** drops the
  payment source and ends access.

Sandbox keys: sign up at <https://comercios.wompi.co>, then **Desarrolladores** → *Llaves del API* with
the environment switched to **Sandbox**: the public and private keys, and under *Secretos para
integración técnica* the events and integrity secrets. Webhook: the same page → **URL de Eventos**
(Sandbox) → paste the URL above. Wompi's sandbox data: card `4242 4242 4242 4242` is approved and
`4111 1111 1111 1111` declined; Nequi number `3991111111` is approved and `3992222222` declined; for PSE
pick the bank that approves.

### 2.5 Complimentary memberships

Admin → Membresías → Miembros: grant a tier to an existing account (by e-mail or login), optionally until
a date; revoke ends it at once (a paid membership is cancelled at its provider immediately).

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
- **Who receives what.** `all` = every subscribed member with an address; `free` = members without a paid
  level; `paid` = members with one. For a post that requires an access level, only members who **hold that
  level** get the full body; everyone else gets the **teaser** (the body before the access break, or the
  author's own excerpt when there is none — never an excerpt derived from the body) plus *Leer en el sitio*.
  Site-relative links and images are made absolute; shortcodes are dropped.
- **Who may send.** Any author can set a meta value, so a post written by an administrator or editor is
  queued at once, while any other author's request waits in the send log for an admin to approve or
  discard it. Each post is emailed once.
- **Unsubscribe.** Every mail ends with a one-click link to `/portal/memberships?u=<id>&t=<token>` (the
  plugin's portal page); the token is an HMAC of the account id under a per-install secret, so it works for
  that account only. The page unsubscribes on open and offers to subscribe again; members can also switch
  newsletters on and off in the **Mi membresía** block. Default: subscribed.
- **Admin.** Membresías → Newsletter: send log with status and delivered / failed counts (failed
  addresses with the error), approve / discard, retry failed, a **test send** (as a member with or without
  access receives it) and sending an already published post.

Without a mail provider nothing is delivered: every delivery fails with the provider's error and shows up
in the log.

### 2.7 Not included (follow-ups)

- **Live mode** for every provider (no live checkout against the owner's own accounts has been run
  yet), the Stripe customer portal, coupons/trials, and per-member analytics.
- Wompi automatic renewal with cards (needs a tokenization flow outside this site's pages) and with
  Bancolombia transfers.
- `List-Unsubscribe` / `List-Unsubscribe-Post` headers: the mail provider plugin does not accept caller
  headers yet; the one-click link is in the body.
- Newsletter open/click tracking and a separate (non-post) campaign editor.

---

## 3. Plugin webhook routes and the HMAC bridge (generic)

Two core additions any plugin can use, introduced for the payment webhooks:

- `wordjs.http.route('post', '/hook', { webhook: true }, handler)` — a signed server-to-server webhook.
  The route is exempt from the CSRF gate (a provider sends no `Origin`/`Referer`) and receives
  `req.rawBody` (the body exactly as received) and the provider's signature headers (any header whose name
  contains `signature` or `checksum`, plus `x-request-id`, `webhook-id`, `webhook-timestamp` and
  `content-type`); in exchange it never
  carries an identity: `req.user` is `null`, no cookies are forwarded, and it cannot be combined with
  `auth`, `admin` or `multipart` (such a registration is refused). POST only.
- `await wordjs.crypto.hmac(algorithm, key, data, encoding?)` (`sha256`/`sha1`/`sha512`, hex or base64,
  data ≤ 2 MB), `await wordjs.crypto.hash(algorithm, data, encoding?)` (an unkeyed digest, same limits —
  for checksums such as Wompi's) and `await wordjs.crypto.timingSafeEqual(a, b)` — for signature checks;
  the static validator keeps `require('crypto')` out of plugin code.

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
