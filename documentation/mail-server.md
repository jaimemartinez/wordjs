# WordJS Mail Server Plugin

The Mail Server is a powerful plugin (`backend/plugins/mail-server`) that adds full MTA capabilities to WordJS: an inbound SMTP server, direct-to-MX outbound delivery, DKIM/SPF/DNSBL/Bayesian security, and a scheduled + retry delivery queue.

> **Optional, operator-trusted, isolated.** The Mail Server is **not** required to run WordJS. Like every plugin it runs **isolated in a `worker_threads` isolate** and reaches core only through the `wordjs` capability bridge. Because it needs **raw sockets** (TCP to remote MX servers on port 25) plus secret options (the DKIM private key) and unscoped DB access, it must run in the **operator-trusted** tier — an untrusted plugin's outbound network is trapped. It ships in the first-party trusted defaults (`config.trustedSystemPlugins`), but trust is enforced server-side and an operator can still toggle it. Activate it only if you want a self-hosted mail server.

## Features

*   **Internal Routing:** Emails between local users are written straight to the database (the recipient's inbox copy) without leaving the server.
*   **Inbound SMTP:** An `smtp-server` listener on port `2525` (configurable) receives mail from the outside world. Hardened against abuse: 25 MB per-message cap, `maxClients: 50`, 60s socket timeout.
*   **Outbound Delivery:** **Direct-to-MX** by default — resolves the recipient domain's MX records and connects on port 25 (STARTTLS when offered). If an SMTP **relay/smarthost** is configured (`mail_server` + credentials), that path is used instead.
*   **Inbound Security:** optional **DNSBL** (Spamhaus zen) at connect, real **SPF** evaluation of the connecting IP against the `MAIL FROM` domain (tag-only or hard-reject), and a **Bayesian spam filter** (auto-trashes spam, learns from user train actions).
*   **Deliverability:** **DKIM** signing (generate a keypair in-app), and a DNS-records helper that emits the DKIM/SPF/DMARC/PTR records an operator must publish.
*   **Reliability:** scheduled send + an outbound **retry queue** with exponential backoff and sender bounce notifications.
*   **Real-time Alerts:** integrates with the Notification System to alert users of new inbound/internal mail instantly.

## Configuration

Settings are managed via the Admin Panel -> **Email Center** -> **Settings** (and persisted as core options).

*   **From identity:** `mail_from_email`, `mail_from_name`.
*   **SMTP listen port:** `smtp_listen_port` (default `2525`).
*   **Catch-All:** `smtp_catch_all` — accept all incoming mail for the domain even when the user doesn't exist.
*   **HELO host:** `mail_helo_host` — the name announced in EHLO; **must** match the sending IP's reverse DNS (PTR) or Gmail/Outlook will reject or spam your mail.
*   **Relay (optional):** `mail_server` / `mail_port` / `mail_user` / `mail_pass` / `mail_secure` — configure a smarthost instead of direct MX.
*   **Security toggles:** `mail_security_dnsbl_enabled`, `mail_security_spf_enabled`, `mail_security_spf_reject`, and DKIM (`mail_security_dkim_domain`, `mail_security_dkim_selector`, plus the secret `mail_security_dkim_private_key`, which is never returned by the settings API).

## Delivery model

A single `send` produces, in order:
1.  **A "Sent" copy** in the sender's mailbox (the source of truth). On retries this record is reused, not duplicated.
2.  **Local inbox copies** for any recipients that resolve to local users (and a notification to each).
3.  **External delivery** for the rest — direct-to-MX (or the configured relay).

The outcome is reported back to the caller (`{ success, delivered, failed }`); the `/send` endpoint returns `207` on partial external failure rather than silently "succeeding".

### Scheduled send & retry queue
*   A 1-minute background timer processes two queues:
    *   **Scheduled:** rows with `scheduled_at <= now` are sent. `scheduled_at` is stored as an **ISO/UTC** timestamp and compared against an ISO bind parameter (`scheduled_at <= ?`) — not SQLite's localtime `datetime('now')` — so timing is correct on any driver.
    *   **Retry:** outbound rows in `delivery_status = 'retry'` whose `next_attempt_at` (also ISO) is due are re-attempted against only the still-failed recipients.
*   **Backoff & give-up:** temporary failures (4xx / network) schedule the next attempt at `attempt²` minutes (cap ~6h) up to `MAX_DELIVERY_ATTEMPTS` (5); permanent failures (5xx) never retry. On final failure the sender gets a **bounce notification**.

### Outbound rate limiting
Per-user, per-rolling-hour caps guard against an authenticated account blasting DKIM-signed spam from your IP: max 50 recipients per message, 100 messages/hour, 500 recipients/hour. Header-bound fields (subject, from-name) are CR/LF-stripped to prevent header injection, and recipient addresses are validated (length, single `@`).

## Developer API

Other plugins send mail through the bridge-provided utility, which the Mail Server registers via `wordjs.provideMail(sendMail)`. The host installs a shim so callers can use `wordjs.mail(...)` (isolated plugins) or the legacy `global.wordjs_send_mail(...)`:

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

All routes are mounted at `/api/v1/mail-server/*`. Highlights:

| Method & path | Purpose |
| --- | --- |
| `POST /send` | Send (or, with `scheduledAt`, schedule) a message. Supports `to/cc/bcc` arrays, `replyToId`, attachments. |
| `POST /drafts` | Create/update a draft. |
| `GET /emails` | List a folder (`inbox`/`sent`/`drafts`/`trash`/`archive`/`starred`), threaded + paginated. |
| `GET /emails/:id` | Read one (returns its thread); ownership-checked. |
| `GET /emails/search`, `GET /users/search` | Search mail / local users. |
| `DELETE /emails/:id`, `PUT /emails/:id/restore`, `DELETE /trash/empty` | Trash lifecycle. |
| `PUT /emails/:id/star`, `PUT /emails/:id/archive` | Flags. |
| `POST /classification/train` | Teach the Bayesian filter (`spam`/`ham`). |
| `GET`/`POST /settings` (admin) | Read/update server settings (secret DKIM key never returned). |
| `POST /test` (admin) | Send a real delivery test and report the SMTP outcome. |
| `GET /security/dns-records` (admin) | The DKIM/SPF/DMARC/PTR records to publish. |
| `POST /security/dkim/generate` (admin) | Generate a 2048-bit DKIM keypair (`{ "force": true }` to rotate an existing key). |
| `GET /attachments/:fileId`, `POST /upload/attachment` | Attachment download/upload. |

```json
// POST /api/v1/mail-server/send
{
    "to": "admin@localhost",
    "subject": "System Alert",
    "body": "<strong>High CPU usage detected.</strong>",
    "isHtml": true
}
```

## Notes
*   **Localhost / dotless domains**: `admin@localhost` and similar are accepted for internal testing.
*   **Storage**: mail lives in the plugin-local `received_emails` / `email_attachments` tables (via the bridge `wordjs.db`); attachments are written under `backend/uploads/mail-attachments`. The Bayesian model persists to `backend/uploads/mail-server-data/bayes.json`.
*   **Logging**: verbose, tagged `[MailServer]`, for tracing delivery paths.
