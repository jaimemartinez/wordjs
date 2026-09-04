# WordJS Notification System

WordJS features a real-time, multi-transport notification system that allows the core and plugins to communicate with users instantly.

## Architecture

The system is a centralized service (`backend/src/core/notifications.ts`) that dispatches messages through multiple "transports". The service is a singleton; `send()` fans a notification out to every registered transport (or a caller-specified subset) and then fires the `notification_sent` action so other plugins can intercept.

### Transports
1.  **DB (Database):** Persists notifications to the `notifications` table for history. (Registered by core.)
2.  **SSE (Server-Sent Events):** Real-time push to the browser. (Registered by core.) The SSE transport always delivers to *this* node's local clients immediately, and — whenever Redis is **configured** (`cache.redisConfigured()`, i.e. a multi-node deployment is expected) — also publishes the notification to the `wordjs:notify` channel so a notification produced on one node reaches another node's SSE clients. The gate is deliberately configuration, not liveness (`pubsubAvailable()` is not used): if Redis is configured but currently down, the publish is still attempted and `cache.publish()` logs a `cross-node coherence DEGRADED` warning instead of the drop being silent. Each message is tagged with a per-process `NODE_ID` so a node skips re-broadcasting its own echo, and `initClusterBus()` (called once at boot in `index.ts`) subscribes the node to that channel. When Redis is not configured this is a no-op (single node); the `db` transport persists regardless, so a briefly-unsubscribed or disconnected remote node recovers on the next list/reload.
3.  **Email:** (Optional) Delivered by the **Mail Server plugin**, which registers an `email` transport at activation via the capability bridge (`wordjs.notify.registerTransport`). Present only while that plugin is active.

Transports are extensible: a plugin can `registerTransport(name, handler)` (slack, push, etc.). Note that **registering a transport requires the admin-granted `notifications: provider` capability** — see [Sending Notifications from Plugins](#sending-notifications-from-plugins).

### Transport scoping & teardown (isolation-aware)
Each transport records the **plugin slug** that registered it. When core's `send()` later invokes a plugin's transport handler, it re-enters that plugin's context (`runWithContext`) so the handler runs back in its sandbox (its separate OS process, via `child_process.fork`) rather than detached as trusted core — the host RPCs the notification back to the child over IPC (`invoke-notify-transport`). When an isolated plugin is unloaded or reloaded, `unregisterPluginTransports(slug)` drops all of its transports so a dispatched notification is never routed to a dead child process.

All transport handlers run under `Promise.allSettled`, so one failing transport (e.g. mail) never blocks the others (DB/SSE).

## Sending Notifications from Plugins

Isolated plugins send notifications through the capability bridge (`wordjs.notify({...})`), which is permission-checked on the host (requires the `notifications: send` scope). `notify` is on the host's **exact bridge-method allowlist** (`ALLOWED_BRIDGE_METHODS` in `backend/src/core/plugin-isolate.ts`), so an isolated plugin reaches it as a normal `kind:'call'` RPC. Core code (e.g. plugins that run in-process) can call the `notificationService` directly.

**Registering a transport is different.** `wordjs.notify.registerTransport(name, handler)` is **not** a generic bridge call — it flows over its own dedicated IPC kind (`register-notify-transport`), and the host **only honors it when the plugin has been admin-granted the `notifications: provider` capability** (`isGrantedFor(slug, 'notifications', 'provider')`, default-deny). Registering a transport is privileged because the handler is invoked for **every** dispatched notification — it can read all notification content — so it requires the admin to grant `notifications: provider` in `/admin/plugins`. When the grant is absent the request is denied (logged: `notify.registerTransport denied: the notifications:provider permission is not granted (grant it in /admin/plugins)`, no transport registered). First-party plugins (e.g. the Mail Server) **declare** the capability in their manifest, but declaring is not granting — the grant is an admin act: activating a plugin (`POST /plugins/:slug/activate`) shows the requested capabilities and grants exactly that declared set, and only while the plugin has no grant record yet, so a revoke of `notifications: provider` in `/admin/plugins` survives a re-activation. (Plugins *already active* when the default-deny model was introduced were grandfathered by a one-time backfill.) They are **not** privileged/trusted — they are still sandboxed, and the handler still runs in the child via `runWithContext`. The handler stays in the plugin's process; the host RPCs each notification back to it (`invoke-notify-transport`) under the plugin's context.

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

Every `send()` is gated by `verifyPermission('notifications', 'send')`, so a plugin cannot dispatch notifications unless its manifest **declares** the `notifications: send` scope **and** an admin has **granted** it (default-deny, Android-style — declaring alone is not enough).

## Persistence & retrieval

Notifications are stored in the `notifications` table (UUID, `user_id`, `type`, `title`, `message`, `data`, `is_read`, `created_at`, `read_at`, `icon`, `color`, `action_url`).

*   **Bounded listing:** `getNotifications(userId, limit = 50)` returns **unread first (capped at `limit`)** plus the **5 most recent read** items, both `ORDER BY created_at DESC`. The query is backed by a composite index `idx_notifications_user_read_created (user_id, is_read, created_at)`, so the per-user listing stays cheap as history grows.
*   `markAsRead(uuid, userId)`, `markAllAsRead(userId)`, and `deleteNotification(uuid, userId)` manage state. The single-item mutators are **owner-scoped** (`WHERE uuid = ? AND (user_id = ? OR user_id = 0)`): a uuid is not a capability, so a caller can only act on their own notification — except a broadcast (`user_id = 0`) which any user may dismiss. They return `true` only when a row the user owns was actually changed (the routes 404 otherwise).

### REST endpoints (`backend/src/routes/notifications.ts`)
*   `GET  /api/v1/notifications/stream` — SSE stream (auth via header, cookie, or query token).
*   `GET  /api/v1/notifications` — list (bounded, as above).
*   `POST /api/v1/notifications/:uuid/read` — mark one read.
*   `POST /api/v1/notifications/read-all` — mark all read.
*   `DELETE /api/v1/notifications/:uuid` — delete one.

The three mutating routes sit behind the double-submit CSRF gate like every other cookie-authenticated write: a caller authenticating with the `wordjs_token` cookie must also send `X-CSRF-Token` equal to its `wjs_csrf` cookie (the frontend spreads `csrfHeaders()` from `lib/csrf.ts` into each of them in `NotificationCenter.tsx`), or the request answers **403** with `code: "rest_csrf_token"`. A caller authenticating with `Authorization: Bearer …` is exempt — it carries no ambient cookie to ride — and the `stream` `GET` is a safe method, never gated.

## Frontend Integration

The frontend connects to the SSE stream at `/api/v1/notifications/stream`. Broadcasts are addressed: a notification with `user_id == 0` goes to all connected clients, otherwise only to clients whose authenticated user matches.

### Components
*   **`NotificationCenter.tsx`**: The main UI component. It handles receiving events, triggering haptic feedback (`navigator.vibrate`), and managing unread counts.
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
