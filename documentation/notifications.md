# WordJS Notification System

WordJS features a real-time, multi-transport notification system that allows the core and plugins to communicate with users instantly.

## Architecture

The system is a centralized service (`backend/src/core/notifications.ts`) that dispatches messages through multiple "transports". The service is a singleton; `send()` fans a notification out to every registered transport (or a caller-specified subset) and then fires the `notification_sent` action so other plugins can intercept.

### Transports
1.  **DB (Database):** Persists notifications to the `notifications` table for history. (Registered by core.)
2.  **SSE (Server-Sent Events):** Real-time push to the browser. (Registered by core.)
3.  **Email:** (Optional) Delivered by the **Mail Server plugin**, which registers an `email` transport at activation via the capability bridge (`wordjs.notify.registerTransport`). Present only while that plugin is active.

Transports are extensible: a plugin can `registerTransport(name, handler)` (slack, push, etc.). Note that **registering a transport is operator-trusted-only** — see [Sending Notifications from Plugins](#sending-notifications-from-plugins).

### Transport scoping & teardown (isolation-aware)
Each transport records the **plugin slug** that registered it. When core's `send()` later invokes a plugin's transport handler, it re-enters that plugin's context (`runWithContext`) so the handler runs back in its sandbox (its separate OS process, via `child_process.fork`) rather than detached as trusted core — the host RPCs the notification back to the child over IPC (`invoke-notify-transport`). When an isolated plugin is unloaded or reloaded, `unregisterPluginTransports(slug)` drops all of its transports so a dispatched notification is never routed to a dead child process.

All transport handlers run under `Promise.allSettled`, so one failing transport (e.g. mail) never blocks the others (DB/SSE).

## Sending Notifications from Plugins

Isolated plugins send notifications through the capability bridge (`wordjs.notify({...})`), which is permission-checked on the host (requires the `notifications: send` scope). `notify` is on the host's **exact bridge-method allowlist** (`ALLOWED_BRIDGE_METHODS` in `backend/src/core/plugin-isolate.ts`), so an isolated plugin reaches it as a normal `kind:'call'` RPC. Core code (e.g. plugins that run in-process) can call the `notificationService` directly.

**Registering a transport is different.** `wordjs.notify.registerTransport(name, handler)` is **not** a generic bridge call — it flows over its own dedicated IPC kind (`register-notify-transport`), and the host **only honors it for operator-trusted plugins** (`isTrustedPlugin(slug)`). For an untrusted plugin the request is denied (logged, no transport registered), because a transport handler can intercept every dispatched notification. The handler stays in the plugin's process; the host RPCs each notification back to it (`invoke-notify-transport`) under the plugin's context.

```javascript
// Isolated plugin (via the capability bridge)
await wordjs.notify({
    user_id: 1,                 // Target User ID (0 for broadcast)
    type: 'info',               // 'info', 'success', 'warning', 'error', 'email', 'alert'
    title: 'Backup Complete',
    message: 'The daily backup finished successfully.',
    icon: 'fa-database',        // FontAwesome class
    color: 'green',             // Tailwind color name
    action_url: '/admin/backups', // Optional click destination
    transports: ['db', 'sse']   // Optional: restrict to specific transports
});
```

Every `send()` is gated by `verifyPermission('notifications', 'send')`, so an untrusted plugin cannot dispatch notifications unless its manifest declares the scope.

## Persistence & retrieval

Notifications are stored in the `notifications` table (UUID, `user_id`, `type`, `title`, `message`, `data`, `is_read`, `created_at`, `read_at`, `icon`, `color`, `action_url`).

*   **Bounded listing:** `getNotifications(userId, limit = 50)` returns **unread first (capped at `limit`)** plus the **5 most recent read** items, both `ORDER BY created_at DESC`. The query is backed by a composite index `idx_notifications_user_read_created (user_id, is_read, created_at)`, so the per-user listing stays cheap as history grows.
*   `markAsRead(uuid)`, `markAllAsRead(userId)`, and `deleteNotification(uuid)` manage state.

### REST endpoints (`backend/src/routes/notifications.ts`)
*   `GET  /api/v1/notifications/stream` — SSE stream (auth via header or query token).
*   `GET  /api/v1/notifications` — list (bounded, as above).
*   `POST /api/v1/notifications/:uuid/read` — mark one read.
*   `POST /api/v1/notifications/read-all` — mark all read.
*   `DELETE /api/v1/notifications/:uuid` — delete one.

## Frontend Integration

The frontend connects to the SSE stream at `/api/v1/notifications/stream`. Broadcasts are addressed: a notification with `user_id == 0` goes to all connected clients, otherwise only to clients whose authenticated user matches.

### Components
*   **`NotificationCenter.tsx`**: The main UI component in the top bar. It handles receiving events, playing sounds, and managing unread counts.
*   **`ToastContext.tsx`**: Displays transient "toast" popups for incoming notifications.

```javascript
window.addEventListener('wordjs:notification', (e) => {
    console.log('New notification received:', e.detail);
});
```

## Stability Improvements
*   **Heartbeat:** The SSE endpoint writes a `: keepalive` comment every **5 seconds** (and an initial `retry: 10000`) to keep proxies from timing out and to surface dead sockets quickly. The interval is cleared on `req` close, which also removes the client.
*   **Resiliency:** Frontend implements **Exponential Backoff** (1s -> 30s) to prevent reconnection storms during outages.
*   **Context Aware:** Connection state tracks accurate `user.id` to avoid duplicate streams on minor React state changes.
