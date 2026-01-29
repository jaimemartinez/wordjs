# WordJS Notification System

WordJS features a real-time, multi-transport notification system that allows the core and plugins to communicate with users instantly.

## Architecture

The system is designed as a centralized service (`src/core/notifications.js`) that dispatches messages through multiple "transports".

### Transports
1.  **DB (Database):** Persists notifications for history.
2.  **SSE (Server-Sent Events):** Real-time push to the browser.
3.  **Email:** (Optional) Delivers via the Mail Server plugin if active.

## Sending Notifications from Plugins

Plugins can send notifications using the global `notificationService`.

```javascript
const notificationService = require('../../src/core/notifications');

await notificationService.send({
    user_id: 1,                 // Target User ID (0 for broadcast)
    type: 'info',               // 'info', 'success', 'warning', 'error', 'email'
    title: 'Backup Complete',
    message: 'The daily backup finished successfully.',
    icon: 'fa-database',        // FontAwesome class
    color: 'green',             // Tailwind color name
    action_url: '/admin/backups' // Optional click destination
});
```

## Frontend Integration

The frontend (`frontend`) connects to the SSE stream at `/api/v1/notifications/stream`.

### Components
*   **`NotificationCenter.tsx`**: The main UI component in the top bar. It handles receiving events, playing sounds, and managing unread counts.
*   **`ToastContext.tsx`**: Displays transient "toast" popups for incoming notifications.

```javascript
window.addEventListener('wordjs:notification', (e) => {
    console.log('New notification received:', e.detail);
});
```

## Stability Improvements (Jan 2026)
*   **Heartbeat:** Server sends Keep-Alive pings every 5 seconds to detect dead connections instantly.
*   **Resiliency:** Frontend implements **Exponential Backoff** (1s -> 30s) to prevent reconnection storms during outages.
*   **Context Aware:** Connection state tracks accurate `user.id` to avoid duplicate streams on minor React state changes.
