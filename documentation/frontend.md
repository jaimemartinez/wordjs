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


## Context Providers & State

The app uses React Contexts to manage global state:
*   **`AuthContext`**: Handles JWT parsing, role-based capabilities, and login/logout methods.
*   **`MenuContext`**: Fetches and caches the admin sidebar menu items from `/api/v1/plugins/menus`.

## Navigation Components

### `SmartLink`
A wrapper around `next/link` that handles conditional prefetching and active state management.
*   Located at: `src/components/SmartLink.tsx`
*   Usage: `<SmartLink href="/admin/posts">Posts</SmartLink>`

## Visual Editing (Puck)

WordJS integrates **Puck** (by Measured) as its visual page builder.

### Configuration
*   **Config File**: `src/components/puck/config.tsx` defines the available components (Hero, Text, Columns, etc.).
*   **Editor Page**: `src/app/admin/puck/[...path]/page.tsx` renders the editor interface.
*   **Render Page**: `src/app/(public)/[...slug]/page.tsx` renders the published page using Puck's `<Render>` component.

### Registering Custom Blocks
Plugins can inject custom blocks into Puck via the Frontend Registry system.
1. Define the block in your plugin's `client/puck/` folder.
2. The system auto-generates a registry that merges core blocks with plugin blocks.

---

## RBAC & Sidebar Filtering

The Admin sidebar dynamically adjusts based on user permissions.
*   **Role-Based Access Control:** User objects now include a `capabilities` array.
*   **Dynamic Filtering:** Each sidebar menu item is mapped to a required backend capability (e.g., `edit_posts`, `manage_options`).
*   **Deduplication:** The `Sidebar` component (`src/components/Sidebar.tsx`) automatically filters out items from `pluginMenus` if they match core menu items (based on `plugin: 'core'` or `href` collisions) to prevent duplicates.
