# Tutorial 13 — React to site changes with webhooks

A webhook lets another system hear about changes on your site as they happen. When something changes,
WordJS sends a signed `POST` to your endpoint, for example to rebuild a static mirror, purge a CDN,
post to a chat channel or sync a CRM. In this tutorial you run a small receiver that **checks the
signature** of every delivery, register it in the admin, and watch real events arrive.

**Time:** about 15 minutes.
**You need:**

- a WordJS site and an administrator account;
- a machine that runs Node.js 18 or newer, **reachable from the WordJS server at a public address**.

WordJS refuses to deliver to private or loopback addresses (`10.x`, `192.168.x`, `127.0.0.1`,
cloud metadata, and so on), so a hook can't be pointed at your internal network. Use a public host,
or a tunnel that gives your machine a public HTTPS address.

## 1. Run the receiver

Copy [`files/webhook-receiver.js`](files/webhook-receiver.js) to the receiving machine. It is about 40
lines with no dependencies. The core of it is the check that every receiver must make:

```js
function verify(headers, rawBody, toleranceSec = 300) {
  const ts = Number(headers['x-wordjs-timestamp']);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');
  const got = String(headers['x-wordjs-signature-256'] || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
```

- The signature is an HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the webhook's secret.
  Compute it over the **raw** bytes, before you parse the JSON.
- Compare in constant time (`timingSafeEqual`).
- Reject old timestamps, so that a captured request can't be replayed later.

The receiver answers `204` to a valid delivery and `401` to anything else. You start it in step 3,
once you have the secret.

## 2. Register the webhook

Open **Admin → Webhooks**:

1. **Name:** `Rebuild static mirror`.
2. **Payload URL:** your receiver's public address, for example `https://hooks.example.com/hook`.
3. **Events:** under **Posts & pages**, pick **published** and **trashed**. If you pick nothing, the
   webhook gets every event except the opt-in ones, such as sign-ins.

Click **Create webhook**. A dialog shows the **signing secret** (`whsec_…`) **once**. Copy it. If you
lose it, use **Rotate secret** on the webhook to get a new one.

A private or loopback IP address is refused straight away (*Webhook URL points to a disallowed
internal address*). A host name is checked again at every delivery, against the address it
resolves to at that moment.

## 3. Start the receiver and send a test

On the receiving machine:

```bash
WEBHOOK_SECRET=whsec_… node webhook-receiver.js
```

```
Listening on :8787/hook
```

Put it behind your HTTPS front end, or set `PORT`. Back in the admin, click **Send test** on the
webhook. The receiver prints:

```
ping  delivery=1  data={"webhookId":1,"message":"Test delivery from WordJS. If this signature verifies, the endpoint is set up correctly."}
```

If it prints `REJECTED: bad signature or stale timestamp` instead, check the secret and the
receiving machine's clock.

## 4. Watch real events

Publish a post, then move it to the trash. The receiver prints one line per event:

```
post.published  delivery=2  data={"id":30,"type":"post","status":"publish","title":"Saturday cupping","slug":"saturday-cupping",…}
post.trashed    delivery=3  data={"id":30,"type":"post","status":"trash",…,"previousStatus":"publish"}
```

Every body has the same envelope: `event`, `eventId`, `timestamp`, `actor` (when known) and `data`.
Payloads never carry passwords, tokens, email addresses or option values.
[webhooks.md](../webhooks.md) lists every event and its fields.

## 5. Deliveries, retries and pausing

**Deliveries** on the webhook lists recent attempts with their status and HTTP code.

- An endpoint must answer `2xx` within 10 seconds. Otherwise the delivery is retried with growing
  delays, 6 attempts in total. The log shows it as **Pending** with the last status, for example
  `HTTP 405`.
- After 20 failures in a row the webhook is paused. **Pause** does the same by hand.
- `X-WordJS-Delivery` stays the same across retries of one delivery, and `eventId` stays the same for
  one event. Use them to ignore a delivery you already handled.

## Troubleshooting

- **Only the test arrives, never real events, on a site you just installed:** restart WordJS once
  (for example `systemctl restart wordjs`).
- **Nothing arrives at all:** the WordJS server must be able to reach your receiver. A private
  address is refused, and so is a host name that resolves to one. Check **Deliveries** for the error.

---
*Tested on 2026-10-17 with WordJS 2.6.0.

- **Admin screens, in a browser:** creating a webhook, the one-time secret, the refusal of a private
  IP address, **Deliveries**, **Send test** and **Delete**.
- **Events:** on a fresh install, a post published and then trashed queued `post.published` and
  `post.trashed`, with the payloads shown above, after one restart of the service. Before that
  restart only the test was delivered, hence the troubleshooting note.
- **Receiver:** the receiver in this tutorial verified a real signed delivery from WordJS. Production
  WordJS never delivers to private addresses, so in the lab this delivery came from a development
  build of the same version with the documented test-only switch for private targets.*
