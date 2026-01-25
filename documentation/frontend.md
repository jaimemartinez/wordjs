# WordJS Frontend Documentation

The Frontend (`frontend/`) is a **Next.js** application serving both the public site and the admin dashboard.

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

## System Components

### `SystemFontsLoader`
**Location:** `src/components/SystemFontsLoader.tsx`
Injects font faces dynamically based on the site's configuration. It prevents FOUT (Flash of Unstyled Text) by loading fonts before the main content matches.

### `RichTextEditor`
**Location:** `src/components/puckConfig.tsx` (Exported)
A custom WRSIWYG editor built for Puck.
*   **Features:** Font picker, color palette, semantic HTML output.
*   **Usage:** Used inside Puck's `Text` component but can be reused elsewhere.

## Navigation Components

### `SmartLink`
A wrapper around `next/link` that handles conditional prefetching and active state management.
*   Located at: `src/components/SmartLink.tsx`
*   Usage: `<SmartLink href="/admin/posts">Posts</SmartLink>`

## UI Component Library 💅

WordJS uses a standardized "Premium" design system. Plugins and core pages should use these components to maintain visual consistency.

### `PageHeader`
**Location:** `src/components/ui/PageHeader.tsx`
Standard header for all admin pages.
*   **Props:**
    *   `title` (string): Main page title.
    *   `subtitle` (string): Helper text below title.
    *   `icon` (string): FontAwesome class (e.g., `fa-users`).
    *   `actions` (ReactNode): Buttons or controls to show on the right.
    *   `backButton` (boolean): Show back arrow (default: false).

### `Card`
**Location:** `src/components/ui/Card.tsx`
The primary container for content. Enforces the `rounded-[40px]` premium styling.
*   **Props:**
    *   `children`: Content.
    *   `title` (string, optional): Card header title.
    *   `variant` ('default' | 'glass' | 'neo'): Visual style.
    *   `padding` ('none' | 'sm' | 'md' | 'lg'): Internal padding.

### `ActionCard`
**Location:** `src/components/ui/ActionCard.tsx`
Clickable cards for dashboards or quick actions.
*   **Props:**
    *   `icon`: FontAwesome class.
    *   `title`: Main text.
    *   `description`: Subtext.
    *   `onClick` / `href`: Action handler.
    *   `variant` ('primary' | 'danger' | 'success' | 'warning' | 'info'): Color theme.

### `Input` / `ModernSelect`
**Location:** `src/components/ui/Input.tsx`, `src/components/ModernSelect.tsx`
Form controls with consistent rounded styling and focus states.

---

## Visual Editing (Puck)

WordJS integrates **Puck** (by Measured) as its visual page builder.

### Configuration
*   **Config File**: `src/components/puckConfig.tsx` defines the available components.
*   **Editor Page**: `src/app/admin/pages/[id]/page.tsx` renders the editor interface.
*   **Render Page**: `src/app/(public)/[...slug]/page.tsx` renders the published page using Puck's `<Render>` component.

### Available Components

#### Content Components

| Component   | Description          | Key Properties                                      |
| ----------- | -------------------- | --------------------------------------------------- |
| **Heading** | Text headings H1-H6  | `title`, `level`, `align`, `css`                    |
| **Text**    | Rich text content    | `content`, `align`, `css`                           |
| **Image**   | Responsive images    | `src`, `alt`, `width`, `height`, `objectFit`, `css` |
| **Button**  | Clickable buttons    | `text`, `href`, `variant`, `size`, `css`            |
| **Divider** | Horizontal separator | `style`, `color`, `thickness`, `css`                |
| **Spacer**  | Vertical spacing     | `height`, `css`                                     |
| **Card**    | Content container    | `title`, `content`, `image`, `link`, `css`          |

#### Layout Components

| Component   | Description       | Key Properties                                        |
| ----------- | ----------------- | ----------------------------------------------------- |
| **Columns** | Multi-column grid | `distribution` (column widths), `columnStyles`, `css` |
| **Section** | Container wrapper | `backgroundColor`, `padding`, `maxWidth`, `css`       |
| **Grid**    | CSS Grid layout   | `columns`, `gap`, `minItemWidth`, `css`               |
| **FlexRow** | Flexbox container | `justify`, `align`, `gap`, `wrap`, `css`              |

#### Interactive Components

| Component     | Description        | Key Properties                          |
| ------------- | ------------------ | --------------------------------------- |
| **Accordion** | Collapsible panels | `items` (array of title/content), `css` |
| **Tabs**      | Tabbed content     | `tabs` (array of label/content), `css`  |

#### Media Components

| Component       | Description         | Key Properties              |
| --------------- | ------------------- | --------------------------- |
| **VideoEmbed**  | YouTube/Vimeo embed | `url`, `aspectRatio`, `css` |
| **AudioPlayer** | Audio player        | `src`, `title`, `css`       |

#### Marketing Components

| Component        | Description     | Key Properties                                                       |
| ---------------- | --------------- | -------------------------------------------------------------------- |
| **PricingTable** | Pricing plans   | `plans` (array with name, price, features), `css`                    |
| **Testimonial**  | Customer quotes | `quote`, `author`, `role`, `image`, `css`                            |
| **CTABanner**    | Call-to-action  | `title`, `description`, `buttonText`, `buttonLink`, `variant`, `css` |

#### Dynamic Content Components

| Component         | Description          | Key Properties                                                     |
| ----------------- | -------------------- | ------------------------------------------------------------------ |
| **PostsGrid**     | Display recent posts | `count`, `columns`, `css`                                          |
| **CategoryPosts** | Posts by category    | `categoryId`, `layout`, `css`                                      |
| **SearchBar**     | Search input         | `placeholder`, `buttonText`, `searchPage`, `align`, `width`, `css` |

### Component CSS Properties

All components include a `css` field that allows custom styling with:
- `margin`, `padding`
- `backgroundColor`, `color`
- `borderRadius`, `borderWidth`, `borderColor`
- And more...

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

## Mobile & Responsive Behavior

The Admin Panel is fully responsive ("Mobile First").

### Sidebar Strategy
*   **Desktop:** Supports "Collapsed" (Icon only) vs "Expanded" (Full width) states, persisted in `localStorage`.
*   **Mobile:** Enforces "Expanded" layout whenever the menu is open.
    *   The `Sidebar.tsx` component overrides `isCollapsed` styles using `md:` prefixes (e.g., `md:w-24 w-80`) to ensure text labels are always visible on small screens.
    *   Uses a Backdrop (`z-[5001]`) and High Z-Index Sidebar (`z-[5002]`) to float above the interface.

### Top Bar
*   **Dynamic Branding:** Fetches site logo and title from the backend Settings API.
*   **Notification Center:** Integrated directly into the mobile header as an "Inline" variant for easy access.
