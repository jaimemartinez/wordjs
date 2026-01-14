# WordJS Plugin Development Guide

This guide will teach you how to create a plugin for WordJS from scratch. WordJS plugins are "full-stack": they can extend the server (API), the browser (Admin UI), and manage their own dependencies automatically.

---

## 1. The Mental Model

A WordJS plugin is simply a folder inside `backend/plugins/`.
*   **Backend (`index.js`):** Runs on the server. Defines API routes and registers the plugin into the system.
*   **Frontend (`client/`):** Runs in the user's browser. Defines the Admin interface and visual blocks for the editor.
*   **Manifest (`manifest.json`):** The brain. Defines name, version, **npm dependencies**, and **frontend hooks**.

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
  "author": "Your Name",
  "dependencies": {
      "uuid": "^10.0.0" 
  },
  "frontend": {
      "adminPage": {
          "entry": "client/admin/page.tsx",
          "slug": "hello-ui"
      },
      "hooks": "client/hooks.tsx"
  }
}
```

> **🔥 Auto-Dependency Management:** 
> WordJS reads the `dependencies` object. When you activate the plugin, the system **automatically installs** missing packages (`npm install`). When you deactivate it, if no other plugin needs them, it **garbage collects** them (`npm uninstall`). Zero manual work.

### Step 2: Backend Entry Point (`index.js`)
Create `index.js`. You can now require your dependencies safely!

```javascript
exports.init = function () {
    const express = require('express');
    const router = express.Router();
    const { v4: uuidv4 } = require('uuid'); // Safe to use!
    const { registerAdminMenu } = require('../../src/core/adminMenu');
    const { getApp } = require('../../src/core/appRegistry');

    // 1. Define a simple API route
    router.get('/message', (req, res) => {
        res.json({ text: "Hello! Unique ID: " + uuidv4() });
    });

    // 2. Register the API
    getApp().use('/api/v1/hello-world', router);

    // 3. Add link to Sidebar
    registerAdminMenu('hello-world', {
        href: '/admin/plugin/hello-world',
        label: 'Hello World',
        icon: 'fa-smile',
        order: 100,
        cap: 'manage_hello_world'
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

### Step 4: Frontend Hooks (`client/hooks.tsx`)
If you want to modify existing WordJS pages (like adding a field to the User Form), use a Hook file.

```tsx
"use client";
import React from 'react';
import { pluginHooks } from '@/lib/plugin-hooks';

// This function is auto-executed when the plugin loads
export const registerMyHooks = () => {
    pluginHooks.addAction('user_form_before_email', (data) => (
        <div className="alert">Hello from the hook!</div>
    ));
};
```

> **React Dynamic Loading:** WordJS generates a dynamic registry. Your hooks file is lazy-loaded only when the plugin is active.

---

## 3. How to Install and Activate

### The Distribution Workflow (Standard)
1.  Compress your plugin folder into a **.zip** file.
2.  Go to **Plugins** -> **Add New / Upload**.
3.  Upload your `.zip`.
4.  Click **Activate**. The system will pause briefly to **install dependencies**.

### The Local Development Workflow (Fast)
1.  Create your folder directly in `backend/plugins/`.
2.  Refresh the **Plugins** list.
3.  Click **Activate**. Watch the server logs to see the dependency magic happening.

---

## 4. Folder Structure Reference

| File/Folder             | Purpose                                         |
| :---------------------- | :---------------------------------------------- |
| `index.js`              | **Server-side**. Initialization, Routes, Hooks. |
| `manifest.json`         | Metadata, **Dependencies**, Entry Points.       |
| `client/admin/page.tsx` | The UI shown when clicking the sidebar link.    |
| `client/hooks.tsx`      | **Global Hooks**. Runs on app load (if active). |
| `client/puck/`          | Visual blocks for the Page Builder.             |

---

## 5. Developer Rules of Gold 🏆

1.  **Auth First:** Never fetch data from the server without headers.
2.  **Declare Dependencies:** Don't assume `nodemailer` or `uuid` exists in standard WordJS. **Declare it in manifest.json**.
3.  **Relative Imports:** In `index.js`, use `../../src/...` to access Core.
4.  **Unique Slugs:** Ensure your plugin folder name and slug are unique.
