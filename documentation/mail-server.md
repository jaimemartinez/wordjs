# WordJS Mail Server Plugin

The Mail Server is a powerful plugin (`plugins/mail-server`) that adds full SMTP capabilities to WordJS. It runs integrated with the backend process, providing high-performance internal delivery and standard external delivery.

## Features

*   **Internal Routing:** Emails sent between local users (e.g., `user@wordjs.local`) are delivered instantly to the database without leaving the server.
*   **Inbound SMTP:** Listens on port `2525` (configurable) to receive emails from the outside world.
*   **Outbound Delivery:** Resolves MX records to deliver emails directly to recipients, or falls back to a configured SMTP relay (Gmail, SendGrid, etc.).
*   **Real-time Alerts:** Integrates with the Notification System to alert users of new emails instantly.

## Configuration

Settings are managed via the Admin Panel -> **Email Center** -> **Settings**.

*   **SMTP Port:** Port to listen for incoming mail (default: 2525).
*   **Catch-All:** If enabled, accepts all incoming email for the domain, regardless of whether the user exists.

## Developer API

Plugins can send emails using the exposed global utility:

```javascript
/* Global Utility */
if (global.wordjs_send_mail) {
    await global.wordjs_send_mail({
        to: 'user@example.com',
        subject: 'Hello',
        text: 'Sent from another plugin!',
        html: '<p>Sent from another plugin!</p>'
    });
}
```

Or via the HTTP API (authenticated):

`POST /api/v1/mail-server/send`

```json
{
    "to": "admin@localhost",
    "subject": "System Alert",
    "body": "<strong>High CPU usage detected.</strong>",
    "isHtml": true
}
```
