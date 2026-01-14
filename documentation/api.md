# WordJS Backend API Documentation (Comprehensive)

The WordJS Backend is a robust, modular CMS core built with Node.js and Express. This document details its architecture, authentication flows, middleware chains, database interactions, and extensibility points.

## 1. Core Architecture

The backend follows a layered architecture inspired by WordPress but implemented with modern Node.js patterns.

### 1.1 Request Lifecycle
1.  **Gateway:** Request enters port `3000` (Gateway).
2.  **Proxy:** Gateway validates `x-gateway-secret` (if internal) or passes through to port `4000` (Backend).
3.  **Global Middleware:**
    *   `Helmet`: Security headers.
    *   `CORS`: Cross-Origin Resource Sharing.
    *   `RateLimit`: DoS protection (API, Auth, Uploads).
    *   `MigrationGuard`: Validates `Host` header against `siteUrl`.
4.  **Routing:** `backend/src/routes/index.js` dispatches to controllers.
5.  **Controller/Handler:** Executes business logic, interacts with Models/DB.
6.  **Response:** JSON response sent back.

### 1.2 Database Abstraction
WordJS uses `sql.js` (SQLite) for a file-based database, ideal for "Zero Config".
*   **Location:** `backend/data/wordjs.db`
*   **Connection:** `backend/src/config/database.js`
*   **Querying:** Uses `better-sqlite3` style prepared statements (`db.prepare(...)`).

---

## 2. Authentication & Authorization

Authentication is handled via **JWT (JSON Web Tokens)**.

### 2.1 Auth Flow
1.  **Login:** `POST /api/v1/auth/login`
    *   Input: `username` (or `email`), `password`.
    *   Validation: `bcrypt` comparison.
    *   Output: `token` (JWT), `user` object.
2.  **Token Usage:**
    *   Header: `Authorization: Bearer <token>`
    *   Lifecycle: Expiration defaults to 7 days (configurable in `.env`).

### 2.2 Permissions Middleware (RBAC)
Located in `backend/src/middleware/permissions.js`.

| Middleware        | Description                            | Usage Example                                                            |
| :---------------- | :------------------------------------- | :----------------------------------------------------------------------- |
| `authenticate`    | Verifies JWT and attaches `req.user`.  | `router.get('/', authenticate, ...)`                                     |
| `can(cap)`        | Requires a specific capability.        | `router.post('/', authenticate, can('edit_posts'), ...)`                 |
| `isAdmin`         | Strict check for 'administrator' role. | `router.delete('/', authenticate, isAdmin, ...)`                         |
| `ownerOrCan(cap)` | resource owner OR capability.          | `router.put('/:id', authenticate, ownerOrCan('edit_others_posts'), ...)` |

### 2.3 Dynamic Roles & Capabilities
Roles are no longer hardcoded. They are stored in the database (table `options`) under the key `wordjs_user_roles`.

*   **Logic:** `backend/src/core/roles.js` manages the abstraction.
*   **Initialization:** Default roles are seeded during installation but can be modified via the Roles UI.
*   **Capabilities:** Users' capabilities are resolved at runtime based on their assigned role in the `roles` manager.

Default roles include:
*   **Administrator:** `*` (All capabilities).
*   **Editor:** `publish_posts`, `edit_others_posts`, etc.
*   **Author:** `publish_posts`, `edit_posts`.
*   **Contributor:** `edit_posts` (cannot publish).
*   **Subscriber:** `read` only.

---

## 3. The Hook System (Actions & Filters)

WordJS implements a WordPress-style Event-Driven Architecture via `backend/src/core/hooks.js`.

### 3.1 Concepts
*   **Actions:** Do something at a specific point (fire-and-forget).
*   **Filters:** Modify data passing through (pipes).

### 3.2 Key Methods
*   `addAction(hook, callback, priority)`
*   `doAction(hook, ...args)`
*   `addFilter(hook, callback, priority)`
*   `applyFilters(hook, value, ...args)`

### 3.3 Common Hooks
*   `init`: Fired after system initialization, before server start.
*   `rest_api_init`: Fired when registering routes (ideal for plugins).
*   `save_post`: Fired after a post is created/updated.

---

## 4. Models & Data Access

Models wrap database operations. Located in `backend/src/models/`.

### 4.1 User Model (`User.js`)
*   **Meta Data:** Supports arbitrary key-value storage via `user_meta` table.
*   **Methods:** `User.create()`, `User.authenticate()`, `user.can()`.

### 4.2 Options API (`core/options.js`)
Global key-value store for system settings.
*   `getOption(key, default)`
*   `updateOption(key, value)` - Auto-serializes JSON.

---

## 5. Standardized Error Handling

All errors should follow the structure defined in `backend/src/middleware/errorHandler.js`.

### 5.1 Error Response Schema
```json
{
  "code": "rest_error_code",   // Machine-readable string
  "message": "Human readable", // User-facing message
  "data": {
    "status": 400              // HTTP Status code
  }
}
```

### 5.2 Common Error Codes
*   `rest_not_logged_in` (401)
*   `rest_forbidden` (403)
*   `rest_no_route` (404)
*   `rest_invalid_param` (400)

---

## 6. API Endpoint Reference (Summary) 📋

All routes are prefixed with `/api/v1`.

### 6.1 Authentication
| Method | Endpoint         | Auth | Description                   |
| :----- | :--------------- | :--- | :---------------------------- |
| `POST` | `/auth/register` | No   | Create a new user account     |
| `POST` | `/auth/login`    | No   | Login and receive a JWT token |
| `GET`  | `/auth/me`       | JWT  | Get current session user data |
| `POST` | `/auth/validate` | JWT  | Check if token is still valid |
| `POST` | `/auth/refresh`  | JWT  | Generate a new fresh token    |

### 6.2 Content & Taxonomy
| Method   | Endpoint            | Auth  | Description                                      |
| :------- | :------------------ | :---- | :----------------------------------------------- |
| `GET`    | `/posts`            | Opt.  | List posts (filters: `type`, `status`, `author`) |
| `GET`    | `/posts/:id`        | Opt.  | Get post details by ID                           |
| `GET`    | `/posts/slug/:slug` | Opt.  | Get post details by URL slug                     |
| `POST`   | `/posts`            | Admin | Create a new post/page                           |
| `PUT`    | `/posts/:id`        | Admin | Update an existing post                          |
| `DELETE` | `/posts/:id`        | Admin | Move post to trash / Delete                      |
| `GET`    | `/categories`       | No    | List all categories                              |
| `POST`   | `/categories`       | Admin | Create a new category                            |
| `GET`    | `/tags`             | No    | List all tags                                    |
| `GET`    | `/media`            | JWT   | List library items                               |
| `POST`   | `/media`            | Admin | Upload a new media file                          |

### 6.3 System & Extensions
| Method | Endpoint                  | Auth  | Description                           |
| :----- | :------------------------ | :---- | :------------------------------------ |
| `GET`  | `/settings`               | No    | Get public site settings (name, desc) |
| `PUT`  | `/settings`               | Admin | Update site settings                  |
| `GET`  | `/plugins`                | Admin | List all installed plugins            |
| `POST` | `/plugins/upload`         | Admin | Install a plugin from ZIP             |
| `POST` | `/plugins/:slug/activate` | Admin | Activate a plugin                     |
| `GET`  | `/themes`                 | Admin | List available themes                 |
| `POST` | `/themes/:slug/activate`  | Admin | Change active theme                   |
| `GET`  | `/setup/status`           | No    | Check if site is installed            |
| `POST` | `/setup/install`          | No    | Run the installation wizard           |
| `GET`  | `/export`                 | Admin | Download a database backup            |

### 6.4 Advanced Management
| Method   | Endpoint              | Auth  | Description                     |
| :------- | :-------------------- | :---- | :------------------------------ |
| `GET`    | `/users`              | Admin | List all registered users       |
| `PUT`    | `/users/:id`          | Admin | Change user role or profile     |
| `GET`    | `/roles`              | Admin | List all dynamic roles          |
| `POST`   | `/roles`              | Admin | Create or update a role         |
| `DELETE` | `/roles/:slug`        | Admin | Delete a custom role            |
| `GET`    | `/roles/capabilities` | Admin | List all available capabilities |
| `GET`    | `/menus`              | JWT   | Get all navigation menus        |
| `GET`    | `/widgets/sidebars`   | No    | Get sidebar regions and widgets |
| `GET`    | `/revisions/post/:id` | JWT   | Get history of a post           |

---

## 7. Developing Extensions

### 6.1 Creating Endpoints
Use the `asyncHandler` wrapper to automatically catch Promise rejections.

```javascript
const express = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');

router.get('/my-endpoint', asyncHandler(async (req, res) => {
    const data = await complexDbOp();
    res.json(data);
}));
```

### 6.2 Security Best Practices
*   **Sanitize:** Use `sanitize-html` for any HTML input.
*   **Validate:** Check all `req.body` params.
*   **Zip Slip:** Use the provided validation middleware for file uploads.
*   **Rate Limit:** Apply `uploadLimiter` for any file handling routes.

---

## 7. Developer Cheatsheet (Cookbook) 🧑‍🍳

Quick copy-paste snippets for common tasks.

### 7.1 How to... Add a New API Endpoint
In your plugin's `index.js`:
```javascript
const express = require('express');
const router = express.Router();
const { authenticate, isAdmin } = require('../../src/middleware/auth');

// Public Endpoint
router.get('/hello', (req, res) => {
    res.json({ message: 'Hello World!' });
});

// Protected Admin Endpoint
router.post('/secret', authenticate, isAdmin, (req, res) => {
    res.json({ secret: 'Only admins see this' });
});

// Register it
const { getApp } = require('../../src/core/appRegistry');
getApp().use('/api/v1/my-plugin', router);
```

### 7.2 How to... Save/Load Settings
Use the global Options API.
```javascript
const { getOption, updateOption } = require('../../src/core/options');

// Save
updateOption('my_plugin_color', '#ff0000');

// Load (with default)
const color = getOption('my_plugin_color', '#000000');
```

### 7.3 How to... Hook into Events
Run code when something happens (e.g., a post is saved).
```javascript
const { addAction } = require('../../src/core/hooks');

addAction('save_post', (post) => {
    console.log(`Post saved: ${post.post_title}`);
    // Do custom logic here (e.g. send email)
});
```

### 7.4 How to... Fetch Data in React (Admin)
**CRITICAL:** Always include the token!
```javascript
const getData = async () => {
    const token = localStorage.getItem("wordjs_token");
    const res = await fetch('/api/v1/my-plugin/hello', {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    console.log(data);
};
```
