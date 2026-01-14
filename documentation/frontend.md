# WordJS Frontend Documentation

The Frontend (`admin-next/`) is a **Next.js** application serving both the public site and the admin dashboard.

## Structure

*   **App Router:** Uses the modern Next.js App Router (`src/app`).
*   **Public Site:** `src/app/(public)/` - Renders blog posts, pages, and themes.
*   **Admin Dashboard:** `src/app/admin/` - Management interface.

## Gateway Integration

The frontend registers itself with the Gateway automatically on startup.
This is handled in **`src/instrumentation.ts`**:

1.  Next.js starts.
2.  `register()` function is called.
3.  Reads `backend/wordjs-config.json` to find the Gateway port and secret.
4.  Sends a `POST` request to the Gateway to register routes (e.g., `/admin`, `/`).

## Visual Editing (Puck)

WordJS uses **Puck** for its visual editor.
*   **Components:** Located in `src/components/puck`.
*   **Plugin Integration:** Plugins can inject custom Puck components ensuring a modular page builder experience.

## Development vs Production

*   **Internal Port:** `3001` (default).
*   **Public Access:** Accessed via Gateway on port `3000` (or `80`/`443` in prod).

Ensure `NEXT_PUBLIC_API_URL` points to the Gateway URL, not direct backend port.

## RBAC & Sidebar Filtering

The Admin sidebar dynamically adjusts based on user permissions.
*   **Role-Based Access Control:** User objects now include a `capabilities` array.
*   **Dynamic Filtering:** Each sidebar menu item is mapped to a required backend capability (e.g., `edit_posts`, `manage_options`).
*   **Implementation:** The `Sidebar` component filters the `coreMenuItems` and `pluginMenus` lists in real-time. If a user lacks a capability, the corresponding menu item is hidden.

Ensure `AuthContext` is used to access the `user.capabilities` array for any custom permission checks in the UI.
