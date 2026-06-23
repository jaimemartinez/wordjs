# WordJS Mail Server Plugin

The Mail Server is a powerful plugin (`backend/plugins/mail-server`) that adds full MTA capabilities to WordJS: an inbound SMTP server, direct-to-MX outbound delivery, DKIM/SPF/DNSBL/Bayesian security, and a scheduled + retry delivery queue.

> **Optional, isolated, per-capability grants — no trust tier.** The Mail Server is **not** required to run WordJS. Like every isolated plugin it runs in a **separate OS process** (`child_process.fork` of `plugin-worker.js`, not a `worker_threads` isolate) and reaches core only through the `wordjs` capability bridge, RPC'd over IPC and permission-checked on the host. There is **no "trusted" tier** — no plugin bypasses the sandbox. The Mail Server works purely from the capabilities its `manifest.json` **requests** and an admin **grants** (default-deny, Android-style). Outbound sockets (DNS + TCP to remote MX servers on port 25, inbound SMTP listen) require the **`network`** grant — without it `net`/`tls`/`dns` are blocked inside the isolate and delivery degrades gracefully. Its secrets (DKIM private key, relay creds) live in the plugin's **own** `wjp_mail_server_secrets` table, not in protected core options; becoming the host-wide mail provider requires the **`email:provider`** grant. As a first-party plugin it is pre-granted its declared capabilities, but it is **not** privileged. Activate it only if you want a self-hosted mail server.

## Features

*   **Internal Routing:** Emails between local users are written straight to the database (the recipient's inbox copy) without leaving the server.
*   **Inbound SMTP:** An `smtp-server` listener on port `2525` (configurable) receives mail from the outside world. Hardened against abuse: 25 MB per-message cap, `maxClients: 50`, 60s socket timeout.
*   **Outbound Delivery:** **Direct-to-MX** by default — resolves the recipient domain's MX records and connects on port 25 (STARTTLS when offered). Each MX host is resolved + validated to a **public** IP, and the connection is **pinned to that validated IP** (the real MX hostname is kept as the TLS `servername` for cert/SNI) so there is no second, attacker-controlled DNS lookup at connect time — closing the DNS-rebinding/TOCTOU window where a hostile recipient domain could aim delivery at loopback / RFC1918 / `169.254.169.254` cloud metadata / CGNAT / IPv6 ULA (the IP check fails closed on an unparseable address). If an SMTP **relay/smarthost** is configured (`mail_server` + credentials), that path is used instead — and because the relay is an **operator-set, admin-only** value that may legitimately be an internal/LAN MTA, it is **exempt** from the public-only pin (the configured hostname is passed straight to nodemailer).
*   **Inbound Security:** **DNSBL** (Spamhaus zen) at connect and real **SPF** evaluation of the connecting IP against the `MAIL FROM` domain are **default-ON** and **fail closed** for external senders — a DNSBL/SPF lookup error rejects with a `451` temp-failure rather than admitting an unverified IP, and an explicit SPF `fail`/`softfail` rejects with `550` (override to tag-only with `mail_security_spf_reject='0'`). Loopback (`127.0.0.1`/`::1`) and authenticated sessions are trusted and bypass both checks. A **Bayesian spam filter** auto-trashes spam and learns from user train actions.
*   **Deliverability:** **DKIM** signing (generate a keypair in-app), and a DNS-records helper that emits the DKIM/SPF/DMARC/PTR records an operator must publish.
*   **Reliability:** scheduled send + an outbound **retry queue** with exponential backoff and sender bounce notifications.
*   **Real-time Alerts:** integrates with the Notification System to alert users of new inbound/internal mail instantly.

## Configuration

Settings are managed via the Admin Panel -> **Email Center** -> **Settings** (and persisted as core options).

*   **From identity:** `mail_from_email`, `mail_from_name`.
*   **SMTP listen port:** `smtp_listen_port` (default `2525`).
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
// POST /api/v1/plugin/mail-server/send
{
    "to": "admin@localhost",
    "subject": "System Alert",
    "body": "<strong>High CPU usage detected.</strong>",
    "isHtml": true
}
```

**Access control:** `POST /classification/train` is **owner-scoped** — only the email's sender/recipient or an administrator may train on / trash it (returns `403` otherwise), so one user can't poison the shared Bayes filter or trash another user's message by id. Attachment downloads encode the (attacker-controlled) filename safely into `Content-Disposition` — an ASCII quoted-string fallback with CR/LF + quotes stripped, plus the real name via RFC 5987 `filename*=UTF-8''`.

## Notes
*   **Localhost / dotless domains**: `admin@localhost` and similar are accepted for internal testing.
*   **Storage**: mail lives in the plugin's own prefixed tables `wjp_mail_server_received_emails` / `wjp_mail_server_email_attachments` (plus `wjp_mail_server_secrets`) via the bridge `wordjs.db`. Because the plugin can only write inside its own directory, attachments are stored under `backend/plugins/mail-server/data/attachments` and the Bayesian model persists to `backend/plugins/mail-server/data/bayes.json`.
*   **Logging**: verbose, tagged `[MailServer]`, for tracing delivery paths.
