# WordJS Plugin Development Guide

This guide will teach you how to create a plugin for WordJS from scratch. WordJS plugins are "full-stack": they can extend the server (API), the browser (Admin UI), and manage their own dependencies automatically.

---

## 1. The Mental Model

A WordJS plugin is simply a folder inside `backend/plugins/`.
*   **Backend (`index.js`):** Runs on the server **inside a separate OS process** (`child_process.fork`) — its own heap, event loop, and OS memory cap. It cannot `require()` core modules directly — it reaches core ONLY through the `wordjs` capability bridge, which is passed to its `init(wordjs)` function. Defines API routes, hooks, shortcodes via `wordjs.*`.
*   **Frontend (`client/`):** Runs in the user's browser. Defines the Admin interface and visual blocks for the editor. These are **build-time** React assets and are unaffected by isolation.
*   **Manifest (`manifest.json`):** The brain. Defines name, version, **`"isolated": true`** (required — non-isolated plugins are rejected), permissions, **npm dependencies**, and **frontend hooks**.

> **🔒 Isolated by default.** Every plugin runs sandboxed in its own OS process (`child_process.fork`, IPC over a structured-clone channel). There is no in-process execution path. A crash, OOM, or even a heap escape is contained to the child — the host process always survives. Your backend code talks to core only via the injected `wordjs` bridge; every bridge call is permission-checked on the host. See **§11 (The `wordjs` Capability Bridge)** below and **[Plugin Isolation](plugin-isolation-proposal.md)**.

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
  "isolated": true,
  "dependencies": {
      "uuid": "^10.0.0" 
  },
  "permissions": [
      { "scope": "settings", "access": "read", "reason": "To display the site title" }
  ],
  "frontend": {
      "adminPage": {
          "entry": "client/admin/page.tsx",
          "slug": "hello-ui"
      },
      "hooks": "client/hooks.tsx"
  }
}
```

> **`"isolated": true` is mandatory.** A plugin without it is rejected at activation/boot
> (`Plugin '<slug>' must declare "isolated": true and use the wordjs bridge — legacy in-process plugins
> are no longer supported.`). Inside the child process you must use the `wordjs` bridge instead of `require`ing core.

> **🔥 Auto-Dependency Management:** 
> WordJS reads the `dependencies` object. When you activate the plugin, the system **automatically installs** missing packages (`npm install`). When you deactivate it, if no other plugin needs them, it **garbage collects** them (`npm uninstall`). Zero manual work.

> [!IMPORTANT]
> **Hard Lock Protection:** If your plugin requires a version of a package that conflicts with another active plugin (e.g., `lodash@^3.0.0` vs `lodash@^4.0.0`), activation will be **blocked** with a clear error message. You must either deactivate the conflicting plugin or update your dependency.

### Bundled Plugins (Advanced)

If you want to avoid dependency conflicts entirely, you can **bundle** your plugin's dependencies. A bundled plugin includes its own `node_modules/` or a compiled bundle file, so it doesn't share dependencies with other plugins.

**Methods to create a bundled plugin:**

| Method                  | How                                                       |
| ----------------------- | --------------------------------------------------------- |
| **Explicit Flag**       | Add `"bundled": true` to `manifest.json`                  |
| **Own `node_modules/`** | Run `npm install` inside your plugin folder               |
| **Bundle File**         | Use `esbuild`/`webpack` to create `dist/plugin.bundle.js` |

**Example: Creating a bundled plugin with esbuild:**
```bash
cd plugins/my-plugin
npm install         # Install deps locally
npx esbuild index.js --bundle --platform=node --outfile=dist/plugin.bundle.js
```

**Example: manifest.json for bundled plugin:**
```json
{
  "name": "My Bundled Plugin",
  "slug": "my-bundled",
  "version": "1.0.0",
  "bundled": true,
  "main": "dist/plugin.bundle.js"
}
```

> [!TIP]
> **When to use bundled plugins:**
> - Your plugin requires a very specific version of a popular library
> - You're distributing a plugin commercially and want zero installation conflicts
> - Your plugin has many dependencies and you want faster activation

### Step 2: Backend Entry Point (`index.js`)
Create `index.js`. Your `init` function receives the `wordjs` bridge — **use it instead of `require`ing
core**. Inside the child process there is no `express`, no `getApp()`, no direct `require('../../src/core/...')`.

```javascript
exports.init = function (wordjs) {
    const { http, adminMenu } = wordjs;

    // 1. Register a JSON API route. The host namespaces it under /api/v1/plugin/hello-world.
    //    The handler runs inside the child process with a mock (req, res) forwarded over RPC.
    http.route('get', '/message', (req, res) => {
        res.json({ text: "Hello from the sandboxed child process!" });
    });

    // 2. Add a link to the Sidebar (declarative — forwarded to core via the bridge)
    adminMenu.add({
        href: '/admin/plugin/hello-world',
        label: 'Hello World',
        icon: 'fa-smile',
        order: 100,
        cap: 'manage_hello_world'
    });

    console.log('Hello World plugin initialized (via the wordjs bridge)!');
};
```

> **The route is namespaced.** Every plugin's routes always mount under
> `/api/v1/plugin/<slug>/...` (so the example above is reachable at `/api/v1/plugin/hello-world/message`).
> There is no absolute-path escape — that was removed with the trusted tier. Fetch it from your admin
> page using that namespaced URL.

### Step 3: Admin Page UI (`client/admin/page.tsx`)
Create the folder structure `client/admin/` and add `page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { PageHeader, Card } from "@/components/ui";

export default function HelloWorldAdmin() {
    const [msg, setMsg] = useState("Loading...");

    useEffect(() => {
        const fetchMsg = async () => {
            const token = localStorage.getItem("wordjs_token");
            // Plugin routes are namespaced under /api/v1/plugin/<slug>/...
            const res = await fetch('/api/v1/plugin/hello-world/message', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            setMsg(data.text);
        };
        fetchMsg();
    }, []);

    return (
        <div className="p-8 md:p-12 h-full bg-gray-50/50 overflow-auto">
            <PageHeader 
                title="Hello World" 
                subtitle="My first WordJS plugin"
                icon="fa-smile"
            />
            
            <Card title="Server Response" variant="glass">
                <div className="bg-blue-50 p-6 rounded-2xl border border-blue-100">
                    <p className="text-blue-700 font-bold text-lg">{msg}</p>
                </div>
            </Card>
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

---

## 3. Frontend Loading Architecture (Hybrid System) ⚡

WordJS uses a hybrid loading system to balance developer productivity and production performance.

### 3.1 Development Mode (`npm run dev`)
In development, the system uses **Next.js Dynamic Imports** pointing directly to your `client/` source files.
- **Benefit:** Hot Module Replacement (HMR) works perfectly. When you save a `.tsx` file, the UI updates instantly.
- **How:** The `generate-plugin-registry.js` script maps slugs to local source paths.

### 3.2 Production Mode (`npm start`)
In production, WordJS avoids the heavy `next build` process when activating plugins. Instead, it uses **Pre-compiled Bundles**.
- **Benefit:** Activating a plugin is instant. No server downtime or high CPU usage.
- **How:** The frontend loads a minified `.js` bundle from the backend API and evaluates it at runtime.

---

## 4. The Pre-compilation Workflow 📦

Before distributing or deploying your plugin, you MUST compile the frontend.

### Step 1: Run the Builder
From the `backend` directory, run:
```bash
node scripts/build-plugin.js hello-world
```

### Step 2: Verification
This script uses **esbuild** to create a `dist/` folder in your plugin with:
- `admin.bundle.js`: Your admin UI.
- `hooks.bundle.js`: Your frontend hooks.
- `manifest.build.json`: Build metadata.

### 🛑 Critical: The React Singleton
WordJS is highly sophisticated about how it handles React. 
- **The Core Problem:** If your plugin bundles its own copy of React, Hooks will fail (Singleton violation).
- **The WordJS Solution:** The build script automatically marks `react`, `react-dom`, and all `@/*` (core components) as **externals**.
- **Runtime Injection:** WordJS injects its own unified React instance into the plugin bundle at runtime. **Never try to bundle React yourself.**

---

## 5. How to Install and Activate

### The Distribution Workflow (Standard)
1.  **Build:** Run `node scripts/build-plugin.js my-plugin`.
2.  **Zip:** Compress your plugin folder (including the new `dist/` folder).
3.  **Upload:** Go to **Plugins** -> **Add New** in the Admin panel.
4.  **Activate:** Plugin works instantly using the pre-compiled bundle.

### The Local Development Workflow (Fast)
1.  Create your folder directly in `backend/plugins/`.
2.  Refresh the **Plugins** list.
3.  Click **Activate**.
4.  Run `npm run dev` in `frontend` to enable Hot Reload for your plugin source.

---

---

## 6. UI Guidelines & Best Practices 🎨

WordJS enforces a **Premium Glassmorphism** design system. To ensure your plugin looks native, follow these rules:

### use `PageHeader`
Always use the standardized header component.
```tsx
<PageHeader title="My Plugin" icon="fa-bolt" />
```

### use `Card` with `rounded-[40px]`
Avoid raw `div` containers for main content. Use the `Card` component, which handles the complex border-radius (`rounded-[40px]`), shadows, and spacing for you.
```tsx
<Card variant="neo">
  <MyForm />
</Card>
```

### Clean Layouts
*   Use `bg-gray-50/50` for page backgrounds.
*   Use `p-8 md:p-12` for page padding.
*   Avoid standard HTML inputs; use the `Input` and `ModernSelect` components.

---

## 7. Security & Permissions 🛡️

WordJS is "Secure by Default". This means your plugin cannot perform any "dangerous" actions (like editing settings or writing files) unless it explicitly asks for permission.

### 7.1 The Permissions Manifest
In `manifest.json`, you must declare every capability your plugin needs:

```json
"permissions": [
    { 
        "scope": "database", 
        "access": "write", 
        "reason": "Required to save custom plugin data" 
    },
    { 
        "scope": "settings", 
        "access": "read", 
        "reason": "To verify site configuration" 
    }
]
```

### 7.2 The AST Scanner
When you activate a plugin, WordJS runs a **Static Analysis Scan**. It parses your code and blocks it if it finds:
*   `eval()` or shell commands (`exec`).
*   Direct access to `global` or `module`.
*   Obfuscated property access (e.g., `global["ev"+"al"]`).
*   Unauthorized `require()` of sensitive Node modules.

This static scan is **mandatory** — it runs on **every** plugin at activation and re-runs on each boot,
fail-closed (an unparseable file blocks the plugin). The separate **engine-level runtime block** of
dynamic code generation (`--disallow-code-generation-from-strings`, which kills a runtime-constructed
`eval`/`new Function(string)`) is **opt-in** via `config.sandbox.blockCodeGen` and is skipped under
ts-node (dev needs codegen to compile TS) — see §7.3.

### 7.3 The Sandbox (where isolation actually lives)

Your backend runs in a **separate OS process** (`child_process.fork` of `plugin-worker.js`) with its
**own heap, event loop, and OS memory** — it cannot see the host's secrets, DB handle, or other plugins.
It reaches core **only** through the `wordjs` bridge, and every bridge call is RPC'd to the host over the
IPC channel (structured-clone, `serialization: 'advanced'`) and permission-checked there against your
manifest. The host owns Express, the DB, the filesystem and secrets; the child gets serialized
request/response data over RPC, never the live socket or DB handle. Because it is a real process, a
crash, an OOM (including off-heap `Buffer`/`ArrayBuffer` growth), or even a heap escape is contained to
the child — the host process always survives.

**Memory is capped in layers:** (a) an **opt-in preventive** cgroup v2 `memory.max` via
`systemd-run --user --scope` (`config.sandbox.useCgroupMemoryCap = true`, probe-gated, no root, Linux
only); (b) a **reactive** host-side RSS poll on every platform (Linux `/proc`, Windows `tasklist`, macOS
`ps`) that `SIGKILL`s a child whose resident set exceeds **768 MB**; (c) a loose `RLIMIT_AS` virtual
backstop (`config.sandbox.addressSpaceCapMb`, default 16384 MB) plus `--max-old-space-size=256` for the
JS heap.

**Network egress:** by default you get **no outbound network**. The raw socket modules
(`net`/`tls`/`dgram`/`http`/`https`/`http2`/`dns`) are denied, and the globals `fetch` / `WebSocket` /
`EventSource` are trapped (they throw). Outbound access opens **only** when an admin grants your plugin
the **`network`** capability (declare `scope: "network"` in your manifest; the grant carries an
exfiltration warning). This is the only network path — there is no trusted tier that bypasses it.

Even **with** `network` granted, egress is confined to **public destinations only**. secure-require hands
you the *egress-guarded* socket module (not the raw one) and the worker wraps the global `fetch` /
`WebSocket` / `EventSource` with the same policy, so the guard blocks loopback, link-local (including
`169.254.169.254` cloud-metadata/IAM), RFC1918 private ranges, CGNAT, IPv6 ULA/loopback and IPv4-mapped
addresses, and **fails closed** on an unresolvable/garbage host. It validates the **actual resolved IP at
connect time** (anti-DNS-rebinding) across `net`/`tls`/`http`/`https`/`http2`/`dgram` and global
`fetch`/`WebSocket`/`EventSource`, so a granted plugin still cannot pivot to internal services or steal
cloud credentials. (This is a userspace guard, not a network namespace — see the residual-risk note below.)

**Defense-in-depth inside the child:** the same runtime guards (secure-require, io-guard) are installed
inside the child process too, so even after a hypothetical escape your `fs`/`child_process` stay
restricted to your declared permissions in every execution path (route handlers, hooks, timers, module
top-level). secure-require also blocks `worker_threads`/`vm`/`module`/`inspector`/`process.binding` and
native addons, and an ESM resolution hook fails closed for the same builtins. The io-guard confines raw
`fs` to your **own** plugin dir (plus a few shared safe zones); the whole `plugins/` tree is intentionally
**not** a safe zone, so you **cannot** read a sibling plugin's files — another plugin's `package.json`,
`node_modules`, `data/`, or encryption-key files are unreachable (no cross-plugin data/secret exfiltration).

> ⚠️ **Residual risk:** the sandbox is OS-process isolation with userspace guards — it is **not yet
> capability-minimal at the syscall level** (seccomp/landlock/dropped-uid are on the roadmap), and a
> *preventive* memory cap on Windows now ships as a Job Object (default-on, probe-gated, pure-JS; the
> reactive RSS poll remains a backstop). See **[Plugin Isolation](plugin-isolation-proposal.md)**.

> **The AST scan runs on every plugin — there is no skip.** With the trusted tier removed, no plugin is exempt from the scan, and `system:admin` no longer exists as a scan-skip. The scan re-runs on **every server boot** to catch code poisoning. (`db-migration` is no longer a plugin — it moved into core; see below.)

For a full list of security rules, see the **[Security Guide](security.md)**.

---

## 8. Folder Structure Reference

| File/Folder             | Purpose                                         |
| :---------------------- | :---------------------------------------------- |
| `index.js`              | **Server-side**. Initialization, Routes, Hooks. |
| `manifest.json`         | Metadata, **Dependencies**, Entry Points.       |
| `client/admin/page.tsx` | The UI shown when clicking the sidebar link.    |
| `client/hooks.tsx`      | **Global Hooks**. Runs on app load (if active). |
| `client/puck/`          | Visual blocks for the Page Builder.             |

---

## 9. Developer Rules of Gold 🏆

1.  **Auth First:** Never fetch data from the server without headers.
2.  **Use the bridge, not `require`:** In `index.js`, accept `init(wordjs)` and call `wordjs.*`. You **cannot** `require('../../src/core/...')`, `express`, or core modules from inside the child process — that path is gone.
3.  **Declare `"isolated": true`:** It is mandatory; a plugin without it is rejected.
4.  **Namespaced routes:** Your routes mount under `/api/v1/plugin/<slug>/...` — fetch them at that path.
5.  **Unique Slugs:** Ensure your plugin folder name and slug are unique.

---

## 10. Advanced Features

### 10.1 Admin Menus & Deduplication ⚠️
WordJS's frontend (`Sidebar.tsx`) automatically **deduplicates** menu items.
*   **Core Items:** Dashboard, Media, Posts, Settings, etc., are hardcoded in the frontend.
*   **Plugin Items:** Fetched from the backend.

If your plugin registers a menu item with the same path as a core item (e.g., `/admin/media`), the frontend will **hide** your plugin's item to prevent React duplicate key errors.
Always use unique paths (e.g., `/admin/plugin/my-plugin-media`) unless you intentionally want to rely on the core item.

**Use `plugin: 'core'` filtering:**
The backend marks standard menus with `plugin: 'core'`. The frontend filters these out from the dynamic list.

### 10.2 Widgets API
Core can register "Widgets" (they appear in the `Widgets` admin panel and can be assigned to sidebars):

```javascript
const { registerWidget } = require('../../src/core/widgets'); // core / non-isolated context only
registerWidget('my_weather_widget', {
    name: 'Weather Widget',
    description: 'Shows local weather',
    render: (options) => `<div>It is sunny!</div>`
});
```

> ⚠️ **Not yet bridge-exposed.** `registerWidget` is NOT on the `wordjs` bridge, so an isolated plugin
> cannot register a widget today (there is no `wordjs.widgets.*`). Expose data via a route + an admin
> page instead, or open an issue to add a `widgets` bridge capability.

### 10.3 Sending Notifications 🔔
Plugins push real-time alerts to the Admin UI via `wordjs.notify(n)` (`notifications:send` permission).
See **[Notification System](notifications.md)** for full details.

### 10.4 Sending Emails 📧
If a mail provider plugin is active, send mail with `wordjs.mail(msg)` (`email:admin` permission;
`email:provider` is the separate grant that `wordjs.provideMail` needs to *become* the host-wide sender).
See **[Mail Server](mail-server.md)** for full details.

### 10.5 Hook System (Actions & Filters) 🪝
WordJS exposes a hook system similar to WordPress. From an isolated plugin you register hooks through
the bridge (`wordjs.hooks`); your callback lives in the child process and the host installs a shim that
calls back into it over RPC.

**Using Actions (Do something):**
```javascript
exports.init = function (wordjs) {
    wordjs.hooks.addAction('init', () => {
        console.log('System is ready!');
    });
};
```

**Using Filters (Modify something):**
```javascript
exports.init = function (wordjs) {
    wordjs.hooks.addFilter('the_content', (content) => {
        return content + '<p>Modified by my plugin!</p>';
    });
};
```

**Debugging Hooks:**
You can use the **Hooks Registry** in the Admin Panel (`/admin/hooks`) to:
1.  **Inspect:** See exactly which hooks are registered and by whom.
2.  **Live Monitor:** Watch events fire in real-time to debug timing issues.

---

## 11. The `wordjs` Capability Bridge (reference)

`init(wordjs)` receives this object. Data methods are **async** (they cross the child→host IPC boundary).
Every call is permission-checked on the host against your manifest.

| Bridge call | Permission | Notes |
| :--- | :--- | :--- |
| `wordjs.options.get(key, default)` / `set(key, value)` | `settings:read` / `write` | Secret-named keys (`*secret*`, `*password*`, `*key*`, `*token*`, `dkim`, certs…) are **never** exposed — to any plugin. |
| `wordjs.db.all(sql, params)` / `get(...)` / `run(...)` | `database:read` / `write` | Always scoped to your own `wjp_<slug>_` tables; SQL referencing core tables (`users`, `options`, `sessions`, …) is rejected. There is no unscoped mode. |
| `wordjs.db.createTable(name, columns)` | `database:write` | Always creates a `wjp_<slug>_`-prefixed table; core table names blocked. |
| `wordjs.db.getType()` | `database:read` | `'sqlite'` vs `'postgres'` — branch your DDL. |
| `wordjs.users.findByEmail / findByLogin / findById / search(...)` | `users:read` | **Safe projection** only: `{ id, userLogin, username, userEmail, displayName, role }` — never `user_pass` or other credential fields. The sanctioned way to read users without core-table access. |
| `wordjs.site.url / domain / adminEmail` | `settings:read` | Read-only site identity. |
| `wordjs.hooks.addAction/addFilter(hook, cb, priority)` · `doAction(hook, ...args)` | — | Callback runs in the child process; host installs an RPC shim. Raw-HTML hooks (`wordjs_head`/`wordjs_footer`) are denied to every plugin. |
| `wordjs.http.route(method, path, [opts,] handler)` | — | Mounted at `/api/v1/plugin/<slug>/path` (always namespaced — no absolute mode). `opts`: `{ auth, admin }` (host runs the real auth middleware), `{ multipart: 'field' }`. Handler gets a mock `(req,res)` over RPC. |
| `wordjs.shortcodes.add(tag, handler)` | — | Handler may be async; expanded via `doShortcodeAsync`. |
| `wordjs.fs.read(relPath, enc)` / `write(relPath, data)` | `filesystem:read` / `write` | Confined to your **own** plugin dir only (realpath-checked) — never the shared `uploads/` dir. `manifest.json` is immutable. |
| `wordjs.mail(msg)` | `email:admin` | Sends via the active mail provider. (Distinct from `email:provider`, which only `wordjs.provideMail` needs.) |
| `wordjs.provideMail(handler)` | `email:provider` | Become the host-wide mail sender (sandboxed; needs the `email:provider` grant). |
| `wordjs.notify(n)` | `notifications:send` | Push an admin notification. |
| `wordjs.notify.registerTransport(name, handler)` | `notifications:provider` | Register a notification transport (sandboxed; needs the `notifications:provider` grant). |
| `wordjs.adminMenu.add(item)` | — | Declarative sidebar item. |
| `wordjs.cron.schedule(ts, recurrence, hook, args)` | — | Host fires the hook back into the child process. |

---

## 12. Per-plugin capability grants (Android-style)

There is **one** plugin model and **no trust tier**: every plugin is sandboxed, and each capability is
**admin-granted per plugin** with **default-deny**. Your `manifest.json` only *requests* a capability;
an admin *grants* each one in the **Plugins** admin page (`/admin/plugins`,
`POST /plugins/:slug/permissions`, persisted in the `plugin_grants` option). A bridge call works only if
the capability is BOTH declared in the manifest AND granted.

**Grantable capabilities:** `database` (read/write — own tables only), `settings` (read/write — non-secret
options), `filesystem` (read/write — own dir), `users:read` (the safe user projection), `email:provider`,
`notifications:provider` / `notifications:send`, and **`network`** (outbound access to **public IPs only**
— the egress guard blocks loopback/link-local/`169.254.169.254` metadata/RFC1918/CGNAT/ULA and validates
the resolved IP at connect time; opt-in, with an exfiltration warning — declare `scope: "network"`).

First-party plugins (`mail-server`, `conference-manager`, the galleries, …) are **pre-granted** the
capabilities they declare for a working out-of-box experience, but they are **not privileged** — they run
in the same sandbox under the same checks as anything you upload.

Changing a plugin's grants **hot-reloads its child process** so the bridge gates re-evaluate and a
`network` change takes effect — no server restart. Granting a higher-risk capability (`network`,
`email:provider`, `notifications:provider`) is a real security decision: the UI warns accordingly. Only
grant capabilities to code you have audited.

> **Removed for good:** there is no shell/`child_process`, native addons, unscoped/core-table DB,
> secret-named options, absolute routes, raw cookie/header control, raw-HTML hooks, or "trusted" tier —
> no plugin can obtain any of these by any grant.


