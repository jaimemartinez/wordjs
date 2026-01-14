# WordJS Plugin Development Guide

This guide will teach you how to create a plugin for WordJS from scratch. WordJS plugins are "full-stack": they can extend the server (API) and the browser (Admin UI).

---

## 1. The Mental Model

A WordJS plugin is simply a folder inside `backend/plugins/`.
*   **Backend (`index.js`):** Runs on the server. Defines API routes and registers the plugin into the system.
*   **Frontend (`client/`):** Runs in the user's browser. Defines the Admin interface and visual blocks for the editor.

---

## 2. Tutorial: Create "Hello World" Plugin

Follow these steps to create a plugin that shows a message in the admin panel.

### Step 1: Create the Folder and Manifest
Create a folder named `hello-world` inside `backend/plugins/`. Inside it, create a `manifest.json`:

```json
{
  "name": "Hello World",
  "slug": "hello-world",
  "version": "1.0.0",
  "description": "My first WordJS plugin",
  "author": "Your Name"
}
```

### Step 2: Backend Entry Point (`index.js`)
Create `index.js` in the plugin folder. This is where you tell WordJS: "I exist, and here is my menu item."

```javascript
exports.init = function () {
    const express = require('express');
    const router = express.Router();
    const { registerAdminMenu } = require('../../src/core/adminMenu');
    const { getApp } = require('../../src/core/appRegistry');

    // 1. Define a simple API route
    router.get('/message', (req, res) => {
        res.json({ text: "Hello from the Backend!" });
    });

    // 2. Register the API under /api/v1/hello-world
    getApp().use('/api/v1/hello-world', router);

    // 3. Add a link to the Admin Sidebar
    registerAdminMenu('hello-world', {
        href: '/admin/plugin/hello-world',
        label: 'Hello World',
        icon: 'fa-smile', // FontAwesome icon
        order: 100,
        cap: 'manage_options' // OPTIONAL: Required capability to see this menu
    });

    console.log('Hello World plugin initialized!');
};
```

### Step 3: Admin Page UI (`client/admin/page.tsx`)
Create the folder structure `client/admin/` and add `page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

export default function HelloWorldAdmin() {
    const [msg, setMsg] = useState("Loading...");

    useEffect(() => {
        const fetchMsg = async () => {
            const token = localStorage.getItem("wordjs_token");
            const res = await fetch('/api/v1/hello-world/message', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            setMsg(data.text);
        };
        fetchMsg();
    }, []);

    return (
        <div className="p-8">
            <h1 className="text-2xl font-bold mb-4">Hello World Plugin</h1>
            <div className="bg-blue-50 p-6 rounded-xl border border-blue-200">
                <p className="text-blue-700 font-medium">{msg}</p>
            </div>
        </div>
    );
}
```

---

## 3. How to Install and Activate

### The Distribution Workflow (Standard)
1.  Compress your plugin folder into a **.zip** file (ensure `manifest.json` is at the root of the zip).
2.  Go to **Plugins** -> **Add New / Upload**.
3.  Upload your `.zip`. WordJS will extract it correctly into the system.
4.  Click **Activate**.

### The Local Development Workflow (Fast)
If you are developing locally, you can skip the zip step:
1.  Create your folder directly in `backend/plugins/` as shown in the tutorial.
2.  Refresh the **Plugins** list in the admin panel.
3.  Click **Activate**.

---

## 4. Folder Structure Reference

| File/Folder             | Purpose                                         |
| :---------------------- | :---------------------------------------------- |
| `index.js`              | **Server-side**. Initialization, Routes, Hooks. |
| `manifest.json`         | Metadata (name, version, author).               |
| `client/admin/page.tsx` | The UI shown when clicking the sidebar link.    |
| `client/puck/`          | Visual blocks for the Page Builder (advanced).  |
| `client/components/`    | Reusable React components for your UI.          |

---

## 5. Developer Rules of Gold 🏆

1.  **Auth First:** Never fetch data from the server without the `Authorization: Bearer <token>` header.
2.  **Relative Imports:** In your `index.js`, use `../../src/...` to access WordJS core modules.
3.  **Unique Slugs:** Ensure your plugin folder name and slug are unique to avoid conflicts.
4.  **Admin UI:** Use TailwindCSS for your Admin pages to keep the design consistent with WordJS.

---

## 6. Advanced: Adding Editor Blocks
If you want your plugin to add blocks to the "Puck" page builder, create a file in `client/puck/MyBlock.tsx`. WordJS will automatically pick it up if you export the correct configuration. (See existing plugins like `card-gallery` for examples).
