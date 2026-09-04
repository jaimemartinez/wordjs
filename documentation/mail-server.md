# WordJS Mail Server Plugin

The Mail Server is a powerful plugin (source in `marketplace/plugins/mail-server`, installed to `backend/plugins/mail-server`) that adds full MTA capabilities to WordJS: an inbound SMTP server, direct-to-MX outbound delivery, DKIM/SPF/DNSBL/Bayesian security, and a scheduled + retry delivery queue.

> **Optional, isolated, per-capability grants — no trust tier.** The Mail Server is **not** required to run WordJS. Like every isolated plugin it runs in a **separate OS process** (`child_process.fork` of `plugin-worker.js`, not a `worker_threads` isolate) and reaches core only through the `wordjs` capability bridge, RPC'd over IPC and permission-checked on the host. There is **no "trusted" tier** — no plugin bypasses the sandbox. The Mail Server works purely from the capabilities its `manifest.json` **requests** and an admin **grants** (default-deny, Android-style). Outbound sockets (DNS + TCP to remote MX servers on port 25, inbound SMTP listen) require the **`network`** grant — without it `net`/`tls`/`dns` are blocked inside the isolate and delivery degrades gracefully. Its secrets (DKIM private key, relay creds) live in the plugin's **own** `wjp_mail_server_secrets` table, not in protected core options; becoming the host-wide mail provider requires the **`email:provider`** grant. Even though it is a first-party plugin, it is **not** privileged: it goes through the same grant path as any plugin. Activating it (`POST /plugins/mail-server/activate`, admin-only) shows the admin the capabilities the manifest requests and grants exactly that declared set — but only while the plugin has no grant record yet, so a per-permission revoke in `/admin/plugins` survives a re-activation. (Plugins that were *already active* when the default-deny model was introduced were grandfathered by a one-time, non-breaking backfill.) Activate it only if you want a self-hosted mail server.

## Features

*   **Internal Routing:** Mail addressed to a colleague's corporate mailbox on the mail domain (an account with the admin-granted `professional_mailbox` flag and an on-domain address) is written straight to the database (the recipient's inbox copy) without leaving the server; mail to a local user's personal address on another domain is delivered out to that provider.
*   **Inbound SMTP:** An `smtp-server` listener on port `25` by default — the port the world actually delivers mail to (configurable via `smtp_listen_port`). The plugin **probes port 25 before binding**: if it can't be bound (`EACCES` — no `CAP_NET_BIND_SERVICE`/root on Linux; `EADDRINUSE` — another MTA already there), it falls back to `2525` and records a **degraded** status (surfaced in `GET /settings` as `inbound_bound_port` / `inbound_degraded` / `inbound_reason` / `inbound_ok`) instead of silently losing inbound. Hardened against abuse: 25 MB per-message cap, `maxClients: 50`, 60s socket timeout.
*   **Outbound Delivery:** **Direct-to-MX** by default — resolves the recipient domain's MX records and connects on port 25 (STARTTLS when offered). Each MX host is resolved + validated to a **public** IP, and the connection is **pinned to that validated IP** (the real MX hostname is kept as the TLS `servername` for cert/SNI) so there is no second, attacker-controlled DNS lookup at connect time — closing the DNS-rebinding/TOCTOU window where a hostile recipient domain could aim delivery at loopback / RFC1918 / `169.254.169.254` cloud metadata / CGNAT / IPv6 ULA (the IP check fails closed on an unparseable address). If an SMTP **relay/smarthost** is configured (`mail_server` + credentials), that path is used instead — and because the relay is an **operator-set, admin-only** value that may legitimately be an internal/LAN MTA, it is **exempt** from the public-only pin (the configured hostname is passed straight to nodemailer).
*   **Inbound Security:** **DNSBL** (Spamhaus zen) at connect and real **SPF** evaluation of the connecting IP against the `MAIL FROM` domain are both **default-ON**. Their failure modes differ deliberately: **DNSBL fails open** — Spamhaus zen refuses queries from public/cloud resolvers, so a lookup *error* is the common case and rejecting on it would blackhole all inbound mail; only a **positive listing** rejects (with `554`), and SPF + the Bayesian filter still apply. **SPF fails closed** for external senders — a temporary evaluation error (`temperror`, including an unexpected resolver throw) **defers with `451`** so the sender retries rather than admitting an unverified IP, and an explicit SPF `fail` (`-all`) **rejects with `550`**. `softfail` (`~all` — what Gmail/Google/Microsoft publish; RFC 7208 §8.5 says it must not be rejected on its own) and `permerror` (a malformed / over-budget policy, §8.6) are **accepted and tagged**, never refused: the verdict is recorded as an RFC 7208 `Received-SPF` header and persisted on the message row (`received_spf`). `mail_security_spf_reject='0'` turns **every** SPF-driven refusal — both the `550` and the `451` — into tag-only; the one deferral it cannot override is when the option lookup itself fails, in which case the message is still deferred with `451` (fail closed, retryable). Loopback connections (`127.0.0.1`, `::1`, and the IPv4-mapped `::ffff:127.0.0.1` that the dual-stack listener reports) are trusted and bypass both checks. The inbound listener is an unauthenticated MTA — the SMTP `AUTH` command is disabled (`disabledCommands: ['AUTH']`), so there are no authenticated inbound sessions; the code's trust of `session.user` is a forward-compatibility guard only, not a supported submission path. A **Bayesian spam filter** classifies every inbound message at delivery and files a positive into the **Spam** folder (the `is_spam` flag, which is a different folder from Trash); it learns only from an explicit user train action, never from its own verdict.
*   **Deliverability:** **DKIM** signing (generate a keypair in-app), a DNS-records helper that emits the DKIM/SPF/DMARC/PTR records an operator must publish, and a **live DNS check** (`GET /security/dns-check`) that resolves MX/A/SPF/DMARC/DKIM and verifies the published DKIM `p=` key matches the generated one — when everything resolves it sets the generic `mail_delivery_ready` option that core features (e.g. password recovery) gate on.
*   **Reliability:** scheduled send + an outbound **retry queue** with exponential backoff and sender bounce notifications.
*   **Real-time Alerts:** integrates with the Notification System to alert users of new inbound/internal mail instantly.

## Configuration

Settings are managed via the Admin Panel -> **Email Center** -> **Settings** (and persisted as core options).

*   **From identity:** `mail_from_email`, `mail_from_name`.
*   **SMTP listen port:** `smtp_listen_port` (default `25`; automatic fallback to `2525` when 25 can't be bound, reported as a degraded status). The manifest also declares `claimPorts: [25]`, so when a distro's preinstalled MTA (Postfix/Exim/Sendmail) is squatting the port, the admin UI can show what is occupying it and — after explicit confirmation — permanently disable that known service and reload the plugin (host-side only, admin routes; never reachable from a plugin, and unknown occupants are only reported, never touched).
*   **Trusted proxy IPs:** `smtp_proxy_ips` — comma/space-separated IPs allowed to send the **PROXY protocol (v1)** header (nginx `stream` with `proxy_protocol on;`, HAProxy `send-proxy`), so the real client IP reaches DNSBL/SPF/logging when inbound mail arrives through a TCP proxy. Only exact IPs are honored, never a blanket trust.
*   **Catch-All:** `smtp_catch_all` — accept all incoming mail for the domain even when the user doesn't exist.
*   **HELO host:** `mail_helo_host` — the name announced in EHLO; **must** match the sending IP's reverse DNS (PTR) or Gmail/Outlook will reject or spam your mail.
*   **Relay (optional):** `mail_server` / `mail_port` / `mail_user` / `mail_pass` / `mail_secure` — configure a smarthost instead of direct MX. The relay credentials (`mail_user`/`mail_pass`) are **secrets**: they are stored encrypted in the plugin's own secrets table, not as core options (see *Secrets at rest* below). `mail_relay_require_tls` (default `'1'`) forces STARTTLS on the non-implicit-TLS relay path so an on-path attacker can't strip TLS and capture the relay creds; an operator with a TLS-less **internal** smarthost can opt out with `mail_relay_require_tls='0'`. `mail_secure='1'` (port 465) is implicit TLS and not subject to this.
*   **Security toggles:** `mail_security_dnsbl_enabled`, `mail_security_spf_enabled`, `mail_security_spf_reject` — all **default ON** (`'1'`); only an explicit `'0'` disables them. Plus DKIM (`mail_security_dkim_domain`, `mail_security_dkim_selector`, plus the secret `mail_security_dkim_private_key`, which is never returned by the settings API).

### Secrets at rest

The DKIM private key (`mail_security_dkim_private_key`) and the relay SMTP credentials (`mail_user`/`mail_pass`) are **not** stored as core options. They live in the plugin's own `wjp_mail_server_secrets` table, **encrypted at rest with AES-256-GCM**. The root key is a 32-byte random value persisted once to `backend/plugins/mail-server/data/.mailenc` (written `0600` where the OS honors mode — `chmod` is re-applied after write; a no-op on Windows) and HKDF-stretched to the per-use AES key. Pre-encryption plaintext rows stay readable (backward compatible), and ciphertext is never returned to callers.

> **Operations note — decrypt failure.** If a stored secret carries the `enc:v1:` marker but its GCM auth tag fails to verify, the plugin logs a clear, actionable operator error and treats the secret as **unset** (returns `''`). This almost always means the `.mailenc` root key was **lost, rotated, or regenerated** (e.g. a DB restore that omitted the key file), not tampering. The plaintext is unrecoverable, so the affected DKIM key / relay credential must be **re-entered** in the mail server settings.

## Delivery model

A single `send` produces, in order:
1.  **A "Sent" copy** in the sender's mailbox (the source of truth). On retries this record is reused, not duplicated.
2.  **Local inbox copies** for recipients that resolve to a local user holding an **active corporate mailbox on the mail domain** — the same predicate the inbound listener uses: the admin-granted `professional_mailbox` flag **plus** an account address actually on the mail domain (see *Email Center visibility* below). Each such recipient also gets a notification (self-sends skip the extra inbox copy and notification, since the Sent record already represents the message). A local account without that flag, or a user's personal address on another domain, is **not** captured locally — it is delivered externally like any other address. Retry passes skip this step; only the still-failed external recipients are re-attempted.
3.  **External delivery** for the rest — direct-to-MX (or the configured relay).

The outcome of a delivery is reported back to the caller as `{ success, delivered, failed }`. Note that by default `POST /send` does **not** deliver synchronously: unless `scheduledAt` is given, the message is held in the outbox for an **undo window** (`mail_undo_send_seconds`, default `10`, clamped to 0–60; editable under Settings) and the endpoint answers `200 { success: true, queued: true, undoSeconds, id, message: 'Sending…' }`. The 15-second background queue then dispatches it; a delivery failure at that point surfaces as retry state / a bounce notification (see below), `POST /emails/:id/retry` re-attempts a `failed`/`retry` message immediately, and `POST /emails/:id/unsend` cancels a message still inside its undo window (or a scheduled send) and turns it back into a draft (`409` once it has been handed off). Only with `mail_undo_send_seconds` set to `0` is delivery synchronous — and then `/send` returns `207` (`success: false`, `delivered`, `failed`) on partial or total external failure rather than silently "succeeding".

### Scheduled send & retry queue
*   A background timer that ticks every **15 seconds** (it was 60 s; the shorter tick is what makes the ~10 s **undo-send** window feel immediate, since a message sits in the outbox until the next tick dispatches it) processes two queues:
    *   **Scheduled:** rows with `scheduled_at <= now` are sent. `scheduled_at` is stored as an **ISO/UTC** timestamp and compared against an ISO bind parameter (`scheduled_at <= ?`) — not SQLite's localtime `datetime('now')` — so timing is correct on any driver.
    *   **Retry:** outbound rows in `delivery_status = 'retry'` whose `next_attempt_at` (also ISO) is due are re-attempted against only the still-failed recipients.
*   **Backoff & give-up:** temporary failures (4xx / network) schedule the next attempt at `attempt²` minutes (cap ~6h) up to `MAX_DELIVERY_ATTEMPTS` (5); permanent failures (5xx) never retry. On final failure the sender gets a **bounce notification**.

### Outbound rate limiting
Per-user, per-rolling-hour caps guard against an authenticated account blasting DKIM-signed spam from your IP: max 50 recipients per message, 100 messages/hour, 500 recipients/hour. Header-bound fields (subject, from-name) are CR/LF-stripped to prevent header injection, and recipient addresses are validated (length, single `@`).

## Developer API

Other plugins send mail through the bridge. **Sending** is the everyday path: `wordjs.mail(msg)` is an **allowlisted bridge call** (in `ALLOWED_BRIDGE_METHODS`) available to any plugin — it requires the `email`/`admin` capability and RPCs to the host, which forwards to whatever plugin is the registered mail provider. **Becoming** the host-wide mail provider is the privileged path: only the Mail Server does that, via `wordjs.provideMail(sendMail)` (the `register-mail-provider` IPC kind). That requires the admin-granted **`email:provider`** capability — there is **no trusted bypass**; the grant is re-checked both at the `register-mail-provider` IPC handler and inside `provideMail` itself, so a plugin without it cannot reach it via a generic `call`. The host installs a shim so callers can use `wordjs.mail(...)` (isolated plugins) or the legacy `global.wordjs_send_mail(...)`:

```javascript
if (global.wordjs_send_mail) {
    await global.wordjs_send_mail({
        to: 'user@example.com',          // string or array
        subject: 'Hello',
        text: 'Sent from another plugin!',
        html: '<p>Sent from another plugin!</p>'
    });
}
```

The Mail Server also registers an **`email` notification transport**, so any `notify({ transports: ['email'] })` is delivered by mail.

### HTTP API (authenticated)

All routes are mounted by the host under `/api/v1/plugin/mail-server/*` (every isolated plugin is namespaced under `/api/v1/plugin/<slug>` — no route-hijack/`absolute` bypass). Highlights:

| Method & path | Purpose |
| --- | --- |
| `POST /send` | Queue a message for sending after the undo window (or, with `scheduledAt`, schedule it; synchronous delivery only when `mail_undo_send_seconds` is `0`). Supports `to/cc/bcc` arrays, `replyToId`, attachments. |
| `POST /emails/:id/unsend` | Cancel a message still in its undo window or scheduled send; it returns to drafts. |
| `POST /emails/:id/retry` | Immediately re-attempt a message in `failed`/`retry` delivery state (only the still-failed recipients). |
| `POST /drafts` | Create/update a draft. |
| `GET /emails` | List a folder (`inbox`/`sent`/`drafts`/`archive`/`starred`/`trash`/`spam`, or `label:<id>`), threaded + paginated. |
| `GET /emails/:id` | Read one (returns its thread); ownership-checked. |
| `GET /emails/search`, `GET /users/search` | Search mail / local users. |
| `DELETE /emails/:id`, `PUT /emails/:id/restore`, `DELETE /trash/empty` | Trash lifecycle. |
| `PUT /emails/:id/star`, `PUT /emails/:id/archive` | Flags. |
| `POST /classification/train` | Teach the Bayesian filter (`spam`/`ham`). |
| `GET`/`POST /settings` (admin) | Read/update server settings (secret DKIM key never returned). |
| `POST /test` (admin) | Send a real delivery test and report the SMTP outcome. |
| `GET /security/dns-records` (admin) | The DKIM/SPF/DMARC/PTR records to publish. |
| `GET /security/dns-check` (admin) | Live-resolve MX/A/SPF/DMARC/DKIM and report ok/missing/mismatch per record; persists the `mail_delivery_ready` flag. |
| `POST /security/dkim/generate` (admin) | Generate a 2048-bit DKIM keypair (`{ "force": true }` to rotate an existing key). |
| `GET /attachments/:fileId`, `POST /upload/attachment` | Attachment download/upload. |

```json
// POST /api/v1/plugin/mail-server/send
{
    "to": "admin@localhost",
    "subject": "System Alert",
    "body": "<strong>High CPU usage detected.</strong>",
    "isHtml": true
}
```

**Access control:** every route above except `GET /mailbox` and the admin ones carries a `mailbox: true` gate, so being authenticated is not enough — the caller needs an **active corporate mailbox**, or the administrator role, or the route answers `403` with `code: "mail_no_corporate_mailbox"`. The gate lives once in the plugin's own `route()` helper rather than in ~30 handlers, and the option-less `route(method, sub, handler)` form means `{ auth: true, mailbox: true }`, so a new route cannot default to public. On top of that, `POST /classification/train` is **owner-scoped** — only the email's sender/recipient or an administrator may train on it (returns `403` otherwise). Training also re-files the message: `spam` flags it into the Spam folder (recording who flagged it, and un-archiving it), and `ham` clears the spam flag and restores it from Trash if it was there — it never trashes anything. So one user can't poison the shared Bayes filter or re-file another user's message by id. Attachment downloads encode the (attacker-controlled) filename safely into `Content-Disposition` — an ASCII quoted-string fallback with CR/LF + quotes stripped, plus the real name via RFC 5987 `filename*=UTF-8''`.

## Notes
*   **Localhost / dotless domains**: `admin@localhost` and similar are accepted for internal testing.
*   **Email Center visibility**: the plugin registers its admin menu (via `wordjs.adminMenu.add`) with `requiresProfessionalMailbox: true`, so core (`GET /plugins/menus`) **hides the Email Center** from users with no active corporate mailbox — they have no WordJS inbox, so the page would be an empty shell. Administrators always keep it, which is why the route gate lets them through too: a stricter rule there would show an admin a menu entry whose page only 403s. That grant is **not** derived from the account's email domain: it is the explicit `user_meta.professional_mailbox` flag (`backend/src/core/mailbox.ts`), writable only by a caller holding `edit_users` (Users → edit user → Professional Mail Account) and listed in `User.update`'s protected-meta set so it can never be mass-assigned through the generic `meta` bag. Schema migration `0006_professional_mailbox_flag` performed that conversion on existing installs, granting the flag only to accounts that could already have set it themselves (administrators and `edit_users` holders) and naming every other on-domain account in the `professional_mailbox_migration_pending` option for the operator to re-enable by hand. The flag is slug/href-agnostic, so any mail plugin gets the same treatment (it isn't tied specifically to the mail-server plugin).
*   **Storage**: mail lives in the plugin's own prefixed tables `wjp_mail_server_received_emails` / `wjp_mail_server_email_attachments` (plus `wjp_mail_server_labels`, `wjp_mail_server_email_labels`, `wjp_mail_server_user_prefs` and `wjp_mail_server_secrets`) via the bridge `wordjs.db`. Because the plugin can only write inside its own directory, attachments are stored under `backend/plugins/mail-server/data/attachments` and the Bayesian model persists to `backend/plugins/mail-server/data/bayes.json`.
*   **Logging**: verbose, tagged `[MailServer]`, for tracing delivery paths.
