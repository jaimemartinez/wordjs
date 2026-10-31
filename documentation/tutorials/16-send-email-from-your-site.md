# Tutorial 16 — Send email from your site

WordJS cannot send email on its own: until a mail plugin is installed, it has no way to send a
password-reset link, a notification or a contact-form message. In this tutorial you install the
**Mail Server** plugin from the Marketplace, point it at an SMTP **relay**, send a test message and
check that **password recovery** mail arrives.

A relay (also called a smarthost) is a mail server that accepts your site's mail and delivers it for
you. Most cloud and home connections block outgoing port 25, and mail sent straight from a new server
usually lands in spam. A relay avoids both problems: SendGrid, Mailgun, Amazon SES, Postmark, your
email provider or your ISP, or a mail server on your own network.

**Time:** about 20 minutes.
**You need:**

- a WordJS site and an administrator account ([Tutorial 1](01-install-on-a-linux-server.md));
- WordJS 2.7.0 or newer, with **Mail Server 3.0.2 or newer** (older versions cannot use a
  relay on a private address and do not show relay errors);
- the relay's host name, port and, if it needs them, a username and password.

If you just want to try this out, step 1 sets up **Mailpit**, a test relay that catches every message
and shows it in a web page instead of delivering it. Corner Roasters uses it to test before switching
to their email provider.

## 1. (Optional) Run a test relay with Mailpit

On a Debian 12 or Ubuntu machine that the WordJS server can reach (a small VM or container on your
network is fine), as root:

```bash
apt-get update && apt-get install -y curl ca-certificates
curl -fsSL -o /tmp/mailpit.tar.gz https://github.com/axllent/mailpit/releases/latest/download/mailpit-linux-amd64.tar.gz
tar -xzf /tmp/mailpit.tar.gz -C /usr/local/bin mailpit
mailpit version
useradd --system --home-dir /var/lib/mailpit --create-home --shell /usr/sbin/nologin mailpit
```

Create `/etc/systemd/system/mailpit.service`:

```ini
[Unit]
Description=Mailpit test mail relay
After=network-online.target

[Service]
User=mailpit
ExecStart=/usr/local/bin/mailpit --smtp 0.0.0.0:1025 --listen 0.0.0.0:8025 --database /var/lib/mailpit/mailpit.db
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
systemctl daemon-reload && systemctl enable --now mailpit
ss -ltnp | grep mailpit    # listening on 1025 (SMTP) and 8025 (web)
```

Mailpit accepts SMTP on port **1025** with no username, no password and no TLS, and shows the
messages at `http://<its address>:8025`. Mailpit accepts mail from anyone who can reach it, so keep
it on a private network.

In the rest of this tutorial the Mailpit machine is `192.168.1.60`. Use your own address.

## 2. Install Mail Server from the Marketplace

Open **Admin → Plugins → Marketplace**, find **Mail Server** and click **Install**. The dialog lists
the permissions the plugin will ask for and says that installing grants nothing yet. Confirm.

## 3. Activate it and grant its permissions

Go back to the **Installed** tab. Mail Server is there, inactive. Click **Activate**. The activation
dialog lists each permission with its risk. The ones this tutorial needs are:

- **Outbound network** — to connect to the relay;
- **Send email as provider** — to become the site's mail sender, so that other plugins' mail (contact
  forms, notifications, newsletters) goes through it. The dialog marks it **Administrator-level**: the
  provider can read what it sends. Password-reset and verification links are *not* handed to it unless
  you allow it (step 8).

Click **Confirm and Activate**. The card now says **Running**, and **Email Center** appears in the
admin menu. You can review or narrow the grants later with **Permissions** on the plugin's card.

> **Receive internet email (port 25)** is only needed to *receive* mail from the internet. You can
> leave it granted; sending works the same either way.

## 4. Open the server console

Click **Email Center**, then the **Mail server** button (the server icon at the bottom of the narrow
toolbar on the left). The **Overview** tab has a **Server health** list. Two warnings are normal on a
site that only sends mail:

- **Listening on port 2525 — internet mail will not arrive.** This is about *receiving* mail; ignore
  it if you only send.
- **Mail domain "…" is not a public domain.** It appears when the site's address is an IP address,
  `localhost` or a local name. Mailboxes on the site then end in `@localhost` (or similar) and cannot
  receive mail from outside. Sending through a relay still works. To fix it, give the site its real
  domain in **Settings → Site address**, or enter the domain in the **DKIM** card of the
  **Configuration** tab.

## 5. Configure the relay

Open the **Configuration** tab.

1. In the **SMTP** card, set **From email (default)** to the address your mail should come from, for
   example `noreply@cornerroasters.example`, and **From name (default)** to `Corner Roasters`. With a
   provider, use an address or domain you have verified with them, or they will refuse the mail.
2. In **Relay / smarthost (optional)**:
   - **Relay host:** your provider's SMTP host (for example `smtp.sendgrid.net`), or `192.168.1.60`
     for Mailpit.
   - **Port:** usually `587` for a provider, `1025` for Mailpit.
   - **Username** and **Password:** from your provider. Leave both empty for Mailpit, or for a server
     on your network that accepts mail from your server's address.
   - **Encryption:** **STARTTLS (587 / 25)** for port 587; **Implicit TLS (465)** for port 465.
   - **Require STARTTLS:** keep **Yes** for any relay on the internet, so that the password is never
     sent without encryption. Choose **No — internal TLS-less relay only** for Mailpit.
3. Click **Save changes**.

Under the relay fields you now see one of these:

- a green **Relay … answered — outgoing mail goes through it.** You are done; go to step 7.
- a red **Relay unavailable: …** with the reason, for example a wrong password or a host that does
  not answer. Fix the field it names and save again.

With **Use the relay: Always** (the default), outgoing mail waits in the **Queue** tab while the relay
is unavailable and is retried; it is never sent directly to recipients' servers instead. Choose
**Only when direct delivery fails** if you want the server to deliver directly and use the relay only
as a backup.

## 6. Allow a relay on your private network

WordJS runs every plugin in a sandbox that lets it connect only to **public** addresses. A relay on
your own network, like Mailpit at `192.168.1.60`, is refused at first:

> **Relay unavailable:** the WordJS plugin sandbox blocks private addresses for plugins — approve
> 192.168.1.60:1025 under "Sandbox access" in the Configuration tab

Under the relay fields, the **Sandbox access** box offers **Allow 192.168.1.60:1025**. Click it. This
lets Mail Server reach **that address on that port only**; every other private address and port stays
blocked. WordJS restarts the plugin, and after a moment the status turns to **Relay 192.168.1.60:1025
answered**. The box now says **192.168.1.60:1025 is allowed for this plugin.**, with a **Withdraw**
button to take it back.

A relay on the internet never needs this step.

> The approval is kept by WordJS, not by the plugin, and every change is recorded in the audit log
> (`plugin.private_egress`). From the API it is `POST /api/v1/plugins/mail-server/private-egress`
> (see the [API reference](../api.md)).

## 7. Send a test message

Open the **Test** tab, enter an address outside your site (your own mailbox, or any address when you
use Mailpit) and click **Send test**. You should see:

> Test message accepted by the recipient mail server (external delivery succeeded).
> `you@example.org via relay — 250 2.0.0 Ok: queued as …`

**via relay** confirms that the relay took the message. With Mailpit, open `http://192.168.1.60:8025`
and you will see **WordJS Mail Server — delivery test**. With a provider, check the inbox (and the spam
folder the first time).

If the relay is unavailable, the test says **Relay unavailable: …** with the same reason as the
Configuration tab, and the message waits in the queue.

## 8. Check password recovery

Password-reset and verification links are **account email**: whoever reads one can take over the
account, so WordJS sends them itself and never hands them to a plugin unless you say so. Open
**Settings → Account email** and choose one of the two:

- **Built-in transport (recommended).** Enter the same relay as in step 5 — host, port, STARTTLS,
  username and password, and a from address — type your own password to confirm, click **Save**, then
  **Send test**. Security **None** is allowed only for a mail server on the WordJS machine itself, so
  this works with Mailpit only when Mailpit runs on the WordJS server (`127.0.0.1`, port `1025`). With
  Mailpit on another machine, as in this tutorial, use the next option.
- **Let Mail Server carry them.** Under **Mail provider plugin**, click **Allow for account email** and
  confirm the warning. Mail Server then receives the reset links, so only do this if you trust it as
  much as an administrator.

The banner at the top of that screen says which way a reset link goes now. Password recovery is
offered only when that way can actually deliver.

1. Sign out, or open the login page in a private window. Below **Login** there is now a **Forgot your
   password?** link.
2. Click it, enter your username or email and click **Send Reset Link**. The page says a link was
   sent if the account exists.
3. The message **Password reset for <your site name>** arrives (in Mailpit or in your inbox). It is
   sent to the account's email address and contains a link that is valid for 30 minutes.
4. Open the link, choose a new password and click **Reset Password**. The page says **Your password
   has been reset.**

If the link points to the wrong address, fix the site's address in **Settings → Site address**: every
link in WordJS mail is built from it.

## Troubleshooting

- **Relay unavailable: the WordJS plugin sandbox blocks private addresses for plugins.** The relay
  is on a private address; do step 6.
- **Relay unavailable: Error upgrading connection with STARTTLS …** with **Require STARTTLS: Yes**.
  The relay does not offer working TLS on that port. For a provider, check the port and the
  **Encryption** setting. Only for a relay on your own network, set **Require STARTTLS** to **No**.
- **Relay unavailable** with an authentication error from the relay: re-enter the username and
  password. The password field stays empty after saving; leaving it empty keeps the stored password.
- **The test works but no "Forgot your password?" link appears.** Reload the login page. The link
  appears only while account email can be delivered: check the banner in **Settings → Account email**
  (step 8) — with Mail Server allowed there, also that the relay answers in the Configuration tab.
- **Mail waits in the Queue tab.** It is retried automatically with growing delays. Once the relay
  answers again, the next retry delivers it, or click **Retry now** in the Queue tab.

---
*Tested on 2026-10-17 on Proxmox with two Debian 12 containers: one with Mailpit v1.31.6 as the relay
(SMTP 1025, web 8025), one with WordJS built from the branch that adds private relays (released as
2.7.0) and Mail Server 3.0.2, installed with `create-wordjs` as in Tutorial 1.

- **In a browser:** installing Mail Server from the Marketplace, the activation dialog, the two
  Server health warnings, the relay settings, **Relay unavailable** for the private relay before the
  approval (in the Configuration and Test tabs), **Allow …**, the green relay status, **Withdraw**
  (the relay was blocked again), the Test tab, and the whole password recovery flow up to
  **Your password has been reset**.
- **In Mailpit:** the test message and the **Password reset for Lab Site** message arrived. A test
  sent while the relay was blocked stayed in the queue and arrived by itself once it was allowed.
- **Lab differences:** the Marketplace read a catalog built from the same branch, because the
  published catalog still had Mail Server 3.0.1. The site was served over plain HTTP through an SSH
  tunnel. A relay provider on the internet (step 5 with a username and password) was not tested.*
