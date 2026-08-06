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

> **Fast path:** `node backend/cli/wordjs.js create plugin my-plugin` scaffolds everything below in one command — manifest (`"isolated": true`, requested permissions), a bridge-idiomatic `index.js` (typed via `backend/types/wordjs-bridge.d.ts` for JSDoc IntelliSense), an admin page and a Puck block — and prints the activate/regenerate flow. See `documentation/cli.md` §2. The tutorial below explains what each piece is.

### Step 1: Create the Folder and Manifest
Create a folder named `hello-world` inside `backend/plugins/`. Inside it, create a `manifest.json`:

```json
{
  "id": "hello-world",
  "name": "Hello World",
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

If you want to avoid dependency conflicts entirely, you can **bundle** your plugin's dependencies so it doesn't share packages with other active plugins. Being "bundled" only tells the core to **skip shared `npm install`/garbage-collection** for this plugin — the backend entry point is still `index.js` (`main.js`/`plugin.js` are also accepted); there is no separate `main` field.

**A plugin counts as bundled if any of these is true (`isBundledPlugin`):**

| Method                  | How                                                       |
| ----------------------- | --------------------------------------------------------- |
| **Explicit Flag**       | Add `"bundled": true` to `manifest.json`                  |
| **Own `node_modules/`** | Run `npm install` inside your plugin folder               |

**Example: manifest.json for a bundled plugin:**
```json
{
  "id": "my-bundled",
  "name": "My Bundled Plugin",
  "version": "1.0.0",
  "isolated": true,
  "bundled": true
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
When `process.env.NODE_ENV === 'development'`, the generated registry
(`frontend/src/lib/pluginRegistry.ts`) resolves your admin page through a `next/dynamic` import of the
**source file** — `import("../../../backend/plugins/<folder>/client/admin/page")`. Your `.tsx` is
therefore a normal node in the dev server's module graph, so Fast Refresh applies to it exactly as it
does to app code.
- **How:** `frontend/scripts/generate-plugin-registry.js` writes one entry per **active** plugin into
  the registry's `DEV_DEFINITIONS` map, keyed by slug and pointing at the path its manifest declares.
- **Caveat:** that map is generated, not dynamic. Adding, activating or deactivating a plugin has to
  re-run the generator (the backend spawns it with the active list in `WORDJS_ACTIVE_PLUGINS`). It
  writes only when the content actually changed, because an identical rewrite still bumps the file's
  mtime and makes Next/Turbopack invalidate and full-reload the browser for nothing.

### 3.2 Production Mode (`npm start`)
In production the registry does not import your source at all. `loadProductionBundle()` fetches
`GET /api/v1/plugins/<slug>/bundle?type=admin`, wraps the returned text in a `Blob`, and `import()`s
the resulting `blob:` URL (marked `webpackIgnore`), so your pre-compiled `dist/admin.bundle.js` is
evaluated inside the already-running page.
- **What that buys you:** no `next build` is needed to serve a plugin's admin UI. A plugin installed at
  runtime (from the Marketplace, say) can never be in the build-time import map, so
  `frontend/src/app/admin/plugin/[slug]/page.tsx` falls back to the same runtime loader
  (`createRemotePluginComponent` in `frontend/src/lib/pluginBundleLoader.ts`) instead of rendering
  "Plugin Not Found".
- **What it requires:** the plugin must ship a built `dist/` (see §4). The fetch asks the backend for a
  pre-compiled bundle, never for your source.

---

## 4. The Pre-compilation Workflow 📦

Before distributing or deploying your plugin, you MUST compile the frontend.

### Step 1: Run the Builder
From the `backend` directory, run:
```bash
node scripts/build-plugin.js hello-world
```

### Step 2: Verification
This script uses **esbuild** to create a `dist/` folder in your plugin with one bundle per declared
frontend entry:
- `admin.bundle.js`: Your admin UI (`frontend.adminPage.entry`).
- `component.bundle.js`: Your Puck block (`frontend.puckComponents.entry`, or the conventional `client/puck/<Pascal>Puck.tsx`).
- `hooks.bundle.js`: Your frontend hooks (`frontend.hooks`).
- `manifest.build.json`: Build metadata.

> A declared entry whose file is missing is a **build error**, not a skip — the build fails loudly
> instead of shipping a plugin whose UI is silently absent at runtime.

### 🛑 Critical: The React Singleton
WordJS is highly sophisticated about how it handles React. 
- **The Core Problem:** If your plugin bundles its own copy of React, Hooks will fail (Singleton violation).
- **The WordJS Solution:** The build script never lets React into your bundle. `react`, `react-dom`, `react-dom/client` and the JSX runtimes — plus a fixed list of host modules (`HOST_MODULES` in `backend/scripts/build-plugin.js`: `@/lib/api`, `@/lib/i18n`, `@/lib/plugin-hooks`, the Modal/I18n/Toast/Auth contexts, `@/components/MediaPickerModal`, and the `StatCard`/`PageHeader`/`Card`/`ActionCard` UI components) — are **rewritten to the `WordJS.*` runtime globals** that `frontend/src/lib/pluginBundleLoader.ts` populates. They are deliberately **not** left as plain esbuild `external`: a bare `import … from "react"` cannot be resolved by the blob-URL module the loader evaluates. Any other `@/*` and `next/*` import does stay a genuine external.
- **Runtime Injection:** WordJS injects its own unified React instance into the plugin bundle at runtime. **Never try to bundle React yourself.**

---

## 5. How to Install and Activate

### The Marketplace (one click)
First-party plugins distributed outside the core build live in the **Marketplace** tab of
`/admin/plugins`. Installing from there downloads the plugin ZIP from the catalog
(`marketplace-index.json`, built by `npm run build:marketplace` from `marketplace/plugins/` and
published as **GitHub release assets** — `marketplace/dist/` is a build output and is **not**
committed), **verifies its sha256** against the catalog entry, and hands it to the **same upload
pipeline** described below (zip-bomb budget, manifest check, AST scan) — a marketplace install is
not privileged in any way. Backend API: `GET /api/v1/marketplace/catalog` /
`POST /api/v1/marketplace/install` (admin-only). The catalog **sources are admin-configurable**
from the Marketplace UI (`GET`/`PUT /api/v1/marketplace/sources`, persisted in the
`marketplace_sources` option as a list of https catalogs, merged with per-source error isolation);
with none configured the default is the GitHub release assets
(`https://github.com/jaimemartinez/wordjs/releases/latest/download`). See
**[Plugins Reference §10](plugins-reference.md)** for the catalog.

### The Distribution Workflow (Standard)
1.  **Build:** Run `node scripts/build-plugin.js my-plugin`.
2.  **Zip:** Compress your plugin folder (including the new `dist/` folder).
3.  **Upload:** Go to **Plugins** -> **Add New** in the Admin panel.
4.  **Activate:** Plugin works instantly using the pre-compiled bundle.

### The Local Development Workflow (Fast)
1.  Scaffold with `node backend/cli/wordjs.js create plugin my-plugin` (or create the folder by hand in `backend/plugins/`), then restart the backend **once** so the new folder is discovered.
2.  Refresh the **Plugins** list.
3.  Click **Activate** (activation hot-loads the sandboxed child process and grants the manifest's requested permissions — default-deny, refinable in `/admin/plugins`).
4.  Run `npm run dev` in `frontend` to enable Hot Reload for your plugin source.
5.  **Backend hot-reload:** while the backend runs with `NODE_ENV=development`, every `.js`/`.json` save inside an active plugin automatically re-spawns its child process (~300 ms debounce; the reload re-runs the AST security scan — see `backend/src/core/plugin-dev-watch.ts`). Manual trigger, any environment (admin): `POST /api/v1/plugins/:slug/reload`.

### Upload validation (what the installer checks)

When you upload a plugin ZIP, WordJS validates it **before** reporting success, so a bad archive fails fast with a clear reason and never lingers on disk:

- **Decompression-bomb cap** — the uncompressed size and entry count are bounded (a small ZIP that expands to gigabytes is rejected). Same guard protects theme uploads and backup restores.
- **Manifest** — must be valid JSON with a `name` and `"isolated": true`.
- **Permissions** — every `{scope, access}` is checked against the known vocabulary; a typo (`databse`, `readwrite`) is rejected with the valid list.
- **AST scan** — the same static scan that runs at activation runs here too; forbidden code (`eval`, `child_process`, dynamic `require`, …) is rejected up front.
- **Live-plugin safety** — re-uploading a slug that is currently **active** is refused (409). Deactivate it first so a botched extract can't corrupt a running plugin.

### Runtime health & auto-restart

Each active plugin runs in its own OS process, and WordJS now **supervises** it:

- The admin **Plugins** screen shows each plugin's live state (Running / Restarting / Crashed / Crash-looping / Stopped), memory (RSS), restart count, last exit code, the last error, and the child's pid.
- If a child crashes at runtime it is **auto-restarted** with exponential backoff (1s → 5s → 15s → 60s). After too many crashes in a short window it is marked **crash-looping** and left stopped (fix it and hit **Reload**).
- `GET /api/v1/plugins/:slug/status` returns that telemetry programmatically, plus the `uptimeMs` and `startedAt` the screen does not render.

### Uninstalling a plugin (and its data)

Deleting a plugin (admin **Plugins** → delete, password-confirmed) removes its folder **and** always purges its permission grants (so a later re-upload of the same slug can't silently inherit old, possibly-revoked grants) and its crash-guard strikes.

By default your plugin's **data tables are kept** (WordPress parity). Tick **"Also delete this plugin's data / tables"** in the delete dialog to additionally `DROP` the plugin's own `wjp_<slug>_*` tables. Only those prefixed tables are dropped — core and other plugins are never touched.

> Options written via `wordjs.options.set` live in a **global** key space with no per-plugin namespace, so they are **not** auto-purged on delete. If your plugin stores option keys, prefix them with your slug and document how to remove them, or clean them up yourself.

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
When you activate a plugin, WordJS runs a **Static Analysis Scan** (`validatePluginPermissions` in
`backend/src/core/plugins.ts`). It parses every `.js`/`.ts`/`.cjs`/`.mjs` file in your plugin — skipping
`node_modules/`, dot-dirs, and the browser-only `client/`, `frontend/` and `dist/` folders — and blocks
the plugin if it finds:
*   A call whose callee is named `eval`, `Function`, `exec`, `execSync`, `spawn` or `fork`. The match is
    on the **name**, so `anything.spawn()` trips it too. The one exemption is a regex literal's
    `.exec()` (`/re/.exec(s)`), which is `RegExp.prototype.exec`, not `child_process`.
*   Any other way to build code from a string: `new Function(…)`, indirect `(0, eval)(x)`,
    `(()=>{}).constructor('…')`, and `const F = [].constructor.constructor`.
*   **Reading** a restricted global as an object — `process`, `global`, `globalThis`, `require`,
    `module`, `arguments`, `__dirname`, `__filename` — or aliasing one (`const p = process`,
    `const { getBuiltinModule } = process`). Assigning to them is deliberately allowed, which is why
    `exports.init = …` and `module.exports = …` still work; the block is on reads. `process` is
    stricter: every property except `process.env` is flagged, assignment or not.
*   Obfuscated property access on one of those globals — a computed member whose key is not a literal,
    e.g. `global["ev"+"al"]`. (Separately, **any** computed member *call*, `obj[k]()`, is flagged as a
    dynamic call regardless of the object.)
*   Sensitive Node builtins, whether reached by `require()`, a static `import`, or a dynamic `import()`
    — a `node:` prefix is stripped first, so `node:child_process` is caught. Hard-blocked:
    `child_process`, `fs/promises`, `http`, `https`, `dgram`, `cluster`, `async_hooks`, `vm`,
    `worker_threads`, `module`, `inspector`, `v8`, `repl`, `sqlite`, `wasi`. `dns` and `net` are the
    two that are **fixable rather than fatal**: they are reported as a *missing capability* instead of a
    hard block. Watch the exact shape that clears them — the scan looks for a manifest entry with
    `"access": "admin"` on `network` or `email`. The scope-only `{ "scope": "network" }` form that §12
    documents (and that every first-party plugin uses) does **not** satisfy it; `mail-server` gets its
    `require('net')` through on the strength of its `email: admin` entry.
    A non-literal specifier (`require(x)`, `import('child'+'_process')`) is itself flagged as
    obfuscation.
*   Undeclared capabilities inferred from call sites: `fs.readFileSync`/`fs.writeFile`/… require
    `filesystem:read`/`write` in your manifest, and `getOption`/`updateOption`/`dbAsync` require the
    matching `settings`/`database` access. (Plain `require('fs')` is not itself a violation — the fs
    call sites are what the scan gates.)

This static scan is **mandatory** — it runs on **every** plugin at activation and re-runs on each boot,
fail-closed (an unparseable file blocks the plugin). The separate **engine-level runtime block** of
dynamic code generation (`--disallow-code-generation-from-strings`, which kills a runtime-constructed
`eval`/`new Function(string)`) is **default-on** — an operator opts OUT with
`config.sandbox.blockCodeGen: false` — and is skipped under ts-node (dev needs codegen to compile
TS) — see §7.3.

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

**CPU and kernel tables are capped too.** When the cgroup scope in (a) is on, it also carries
`MemorySwapMax=0` and `TasksMax=512` — so a fork/thread-bomb exhausts your **own** cgroup, not the host
task table — and, if the operator sets **`config.sandbox.cpuQuotaPercent`** (**opt-in**, default `0` =
off), a `CPUQuota=N%` cap where 100 = one full core, so a runaway plugin cannot peg every core. The CPU
quota only takes effect **together with** `useCgroupMemoryCap`: both share one `systemd --user` scope and
the probe validates that exact property set before the mode activates, so enabling it on a host whose
`cpu` controller is not delegated falls back to the normal launch instead of failing to start. On the
non-cgroup Linux path the child also gets `RLIMIT_NOFILE=4096` alongside the `RLIMIT_AS` backstop.

**Network egress:** by default you get **no outbound network**. The raw socket modules
(`net`/`tls`/`dgram`/`http`/`https`/`http2`/`dns`) are denied, and the globals `fetch` / `WebSocket` /
`EventSource` are trapped (they throw). The raw resolver stays denied even *with* `network` (it would
bypass egress filtering), so MX/TXT lookups go through the host-mediated `wordjs.dns.*` bridge in §11.
Outbound access opens **only** when an admin grants your plugin
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

> ⚠️ **Residual risk:** the baseline sandbox is OS-process isolation with userspace guards.
> **Kernel hardening** ships **default-on** on Linux (`config.sandbox.useKernelHardening`, **opt-out
> via `config.sandbox.useKernelHardening=false`, probe-gated** — it falls back to the plain isolated
> fork where `bwrap` / unprivileged user-namespaces are unavailable; a no-op on Windows/macOS): bwrap
> runs the child as an unprivileged uid (65534) in a rootless **user** namespace with all Linux
> capabilities dropped, no-new-privs, PID/IPC/UTS namespaces and a read-only root filesystem — only your
> own plugin dir and the io-guard write zones are bound writable, and `/tmp` is a private tmpfs — plus a
> **seccomp-bpf syscall denylist** (`ptrace`, `mount`, `pivot_root`, `setns`, `bpf`, `keyctl`,
> `userfaultfd`, `process_vm_*`, the `io_uring` calls, the new mount API…). The probe boots a child
> through that full profile, seccomp filter included, before the mode activates.
> With that active, a plugin **without** the `network` grant is additionally dropped into its own **empty
> network namespace** (`bwrap --unshare-net`, `config.sandbox.unshareNetwork`, default-on and separately
> probe-gated), so the JS egress neuter is backed by the kernel; a `network`-granted plugin is never
> net-unshared (its sockets must work). Its state is reported as `netns` on `GET /health/details`.
> Landlock is intentionally **not** used (the read-only mount namespace already meets its fs-confinement
> goal and the LSM would need a native dep, against this sandbox's no-native-deps design). With hardening
> off, the child is **not** capability-minimal at the syscall level. Set
> `config.sandbox.requireHardening=true` (opt-in, default off) to **fail closed** — isolated plugins then
> refuse to launch unless kernel hardening is actually active on the host, rather than silently degrading
> to the JS-guards-only fork. It gates on the bwrap probe, so it is a **Linux** switch: on Windows/macOS
> that probe can never pass, and turning it on there refuses **every** plugin. The live hardening state
> (`active` / `degraded` / `disabled` / `unsupported` / `unknown` — `unknown` until the first isolated
> plugin activates, since the probe runs lazily) is surfaced
> on admin `GET /health/details`, where `requireHardening` + `degraded` reports `status: REFUSING`.
> A *preventive* memory cap on Windows
> ships as a Job Object (default-on, probe-gated, pure-JS; the reactive RSS poll remains a backstop).
> The one OS-level confinement that is **not** Linux-only is Node's own **permission model**
> (`config.sandbox.usePermissionModel`, default-on, probe-gated, compiled builds only — skipped under
> ts-node): it is enforced in **C++ below JavaScript**, with no API to re-grant from inside the process,
> so a plugin that defeats a JS guard still meets it. Filesystem reads are scoped to the app root, writes
> to the zones io-guard permits, and `child_process` / `worker_threads` / native addons / WASI are simply
> never granted — denied without the runtime having to know their names, which is the property a by-name
> denylist cannot have. It is probed rather than assumed, because the flag was renamed between Node
> versions (`--permission` vs `--experimental-permission`) **and a build can accept it without enforcing
> it**: it activates only once a real child has actually been refused a read. Note it does **not** gate
> the network — Node's permission model has no `--allow-net` token, so the JS egress guard above remains
> the sole authority on outbound traffic. It is reported
> separately as `permission` on `GET /health/details`, because a host can be un-hardened (no bwrap) and
> still have capability confinement. The
> outstanding gap is an **independent external security audit** — the sandbox is candidly **self-audited**.
> See **[Plugin Isolation](plugin-isolation-proposal.md)** — read its status banner for the as-built
> detail; sections 1–7 of that file are the original design record, kept for the threat model.

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
registerWidget('my_weather_widget', 'Weather Widget', {
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
| `wordjs.db.all(sql, params)` / `get(...)` / `run(...)` | `database:read` / `write` | Always scoped to your own `wjp_<slug>_` tables; SQL referencing core tables (`users`, `options`, `sessions`, …) is rejected. There is no unscoped mode. DDL is limited to your OWN `TABLE`/`INDEX`/`VIEW`/`TRIGGER` (SCHEMA/DATABASE/ROLE/FUNCTION/EXTENSION/… denied), an `ALTER … RENAME TO` target must keep your prefix, and a data-modifying `WITH` (a CTE containing insert/update/delete/replace/merge) counts as a write and needs `database:write`. |
| `wordjs.db.batch(statements)` | `database:read` / `write` | Up to 200 `[sql, params]` pairs in ONE host round-trip — a transport optimisation only: each statement is re-checked with the same permission + SQL guard as the single-statement call, and DDL is refused (use `db.run` / `db.createTable`). Validated as a whole before anything runs, but **not** a transaction — a mid-batch failure leaves the earlier statements applied. |
| `wordjs.db.createTable(name, columns)` | `database:write` | Always creates a `wjp_<slug>_`-prefixed table; core table names blocked. |
| `wordjs.db.getType()` | `database:read` | Returns `{ isPostgres, isMySQL, isSQLite, driver }` (`driver` is the full driver name, e.g. `'sqlite-native'`, `'sqlite-legacy'`, `'postgres'`, `'mysql'`, or `'mariadb'`) — branch your DDL on the `isPostgres`/`isMySQL` booleans rather than the raw `driver` string (`isMySQL` is `true` for both `'mysql'` and `'mariadb'`). Note `isSQLite` stays `true` under MySQL (the MySQL driver translates the SQLite dialect), so gate SQLite-only queries (`PRAGMA`/`sqlite_master`) on `isMySQL` explicitly. |
| `wordjs.users.findByEmail / findByLogin / findById / search(...)` | `users:read` | **Safe projection** only: `{ id, userLogin, username, userEmail, displayName, role, hasProfessionalMailbox }` — never `user_pass` or other credential fields. The sanctioned way to read users without core-table access. (`hasProfessionalMailbox` is the admin-owned corporate-mailbox grant as a boolean — read it, never re-derive it from `userEmail`, which the account itself can write.) |
| `wordjs.site.url / domain / adminEmail` | `settings:read` | Read-only site identity. |
| `wordjs.dns.resolveMx / resolveTxt / resolve4 / resolve6 / resolve(...)` | `network` | Host-mediated DNS. The raw resolver (`dns.resolve*`) is denied inside the child, so MX (direct delivery) and TXT (SPF/DKIM/DMARC) lookups go through here. The host strips every A/AAAA answer pointing at a private/internal address, so the address lookups return public IPs only. |
| `wordjs.hooks.addAction/addFilter(hook, cb, priority)` · `doAction(hook, ...args)` | — | Callback runs in the child process; host installs an RPC shim. Raw-HTML hooks (`wordjs_head`/`wordjs_footer`) are denied to every plugin. `doAction` fires only your OWN registered callbacks — never core's or another plugin's. |
| `wordjs.http.route(method, path, [opts,] handler)` | — | Mounted at `/api/v1/plugin/<slug>/path` (always namespaced — no absolute mode). `opts`: `{ auth, admin }` (host runs the real auth middleware), `{ multipart: 'field' }`. Handler gets a mock `(req,res)` over RPC. |
| `wordjs.shortcodes.add(tag, handler)` | — | Handler may be async; expanded via `doShortcodeAsync`. |
| `wordjs.fs.read(relPath, enc)` / `write(relPath, data)` | `filesystem:read` / `write` | Confined to your **own** plugin dir only (realpath-checked) — never the shared `uploads/` dir. `manifest.json` is immutable. |
| `wordjs.mail(msg)` | `email:admin` | Sends via the active mail provider. (Distinct from `email:provider`, which only `wordjs.provideMail` needs.) |
| `wordjs.provideMail(handler)` | `email:provider` | Become the host-wide mail sender (sandboxed; needs the `email:provider` grant). |
| `wordjs.notify(n)` | `notifications:send` | Push an admin notification. |
| `wordjs.notify.registerTransport(name, handler)` | `notifications:provider` | Register a notification transport (sandboxed; needs the `notifications:provider` grant). |
| `wordjs.adminMenu.add(item)` | — | Declarative sidebar item. |
| `wordjs.cron.schedule(ts, recurrence, hook, args)` | — | Host fires the hook back into the child process — only **your** callbacks, never core's. `recurrence` is a registered schedule name (`'hourly'`, `'twicedaily'`, `'daily'`, `'weekly'`, `'off'`); pass `false` for a one-off event at `ts`. An unregistered name is stored with a 0 interval, so it never repeats. |
| `wordjs.crypto.randomToken(bytes=16)` / `randomInt(min, max)` | — | CSPRNG (no data access, no permission gate). Use instead of `Math.random` for tokens/access codes. **Async** in an isolated plugin (RPC to host) — `await` it. |
| `wordjs.assets.enqueueScript(spec)` / `enqueueStyle(spec)` | `assets:write` | Load a `<script>`/`<style>` from **inside your plugin dir** onto public pages. `spec = { handle, src (relative path), inFooter?, strategy?:'async'\|'defer', media? }`. The host validates the file exists + can't escape and emits a **sanitized** tag served from `/plugins/<slug>/` — you never control raw markup (the raw-HTML head/footer hooks stay denied). |

---

## 12. Per-plugin capability grants (Android-style)

There is **one** plugin model and **no trust tier**: every plugin is sandboxed, and each capability is
**admin-granted per plugin** with **default-deny**. Your `manifest.json` only *requests* a capability;
an admin *grants* each one in the **Plugins** admin page (`/admin/plugins`,
`POST /plugins/:slug/permissions`, persisted in the `plugin_grants` option). A bridge call works only if
the capability is BOTH declared in the manifest AND granted.

**Grantable capabilities** (the canonical manifest vocabulary is `KNOWN_PERMISSIONS` in
`backend/src/core/plugins.ts`): `database` (read/write — own tables only), `settings` (read/write —
non-secret options), `filesystem` (read/write — own dir), `users:read` (the safe user projection),
`assets:write` (enqueue own scripts/styles on public pages), `email:admin` (send through the active mail
provider) / `email:provider` (*become* the provider), `notifications:send` / `notifications:provider`,
`express:register_route`, `admin_menu:register`, and **`network`** (outbound access to **public IPs only**
— the egress guard blocks loopback/link-local/`169.254.169.254` metadata/RFC1918/CGNAT/ULA and validates
the resolved IP at connect time; opt-in, with an exfiltration warning — declare `scope: "network"`).
An admin may narrow a `network` plugin further with a per-plugin **egress host allowlist**
(`GET`/`POST /api/v1/plugins/:slug/egress-hosts`, stored in the `plugin_egress_hosts` option): empty =
allow-all-public, a non-empty list flips that plugin to default-deny for everything but the listed hosts
and their subdomains.

> `scope: "admin"` on a capability implies only its ordinary `read`+`write` verbs — it never subsumes the
> high-power verbs (`provider`, `register`, `register_route`), which must be granted explicitly.
> `express:register_route` and `admin_menu:register` are validated, grantable manifest vocabulary but
> have no `verifyPermission` gate behind them today: route and sidebar registration are policed by the
> caps and allowlists in `plugin-isolate.ts` / `adminMenu.ts` instead (which is why they show `—` in the
> bridge table above).

There is no first-party pre-seeding: **activation** grants a plugin exactly the capabilities its
manifest declares (idempotent — only when the plugin has no prior grant record), and that applies
identically to first-party plugins (`mail-server`, `conference-manager`, the galleries, …) and
anything you upload. First-party plugins are **not privileged** — they run in the same sandbox under
the same checks.

Changing a plugin's grants **hot-reloads its child process** so the bridge gates re-evaluate and a
`network` change takes effect — no server restart. Granting a higher-risk capability is a real security
decision, and the UI says so: `frontend/src/lib/permissionMeta.ts` classifies `database:write`,
`settings:write`, `filesystem:write`, `email:admin`, `email:provider`, `notifications:provider` and
`network` as **high risk**, and both grant screens (the activation dialog and the per-permission
toggles) render those rows with a `HIGH RISK` badge, a platform-authored explanation, and — separately
labelled — the plugin's own stated reason from its manifest. `network` carries the explicit wording
that data can leave your server. Only grant capabilities to code you have audited.

> **Removed for good:** there is no shell/`child_process`, native addons, unscoped/core-table DB,
> secret-named options, absolute routes, raw cookie/header control, raw-HTML hooks, or "trusted" tier —
> no plugin can obtain any of these by any grant.

---

## 13. Puck Blocks (Visual Editor Components) 🧩

Plugins can add blocks to the visual page builder (Puck). This is how it actually works, end to end.

### 13.1 Declare the entry in `manifest.json`

`frontend.puckComponents` is an **object** with a single `entry` (**not** an array):

```json
"frontend": {
    "puckComponents": { "entry": "client/puck/MyPluginPuck.tsx" }
}
```

If you omit it, a convention fallback is tried: `client/puck/<Pascal>Puck.tsx`, where `<Pascal>` is the PascalCase of the plugin folder (e.g. `card-gallery` → `CardGalleryPuck.tsx`).

### 13.2 The export contract

`frontend/scripts/generate-puck-plugin-registry.js` reads your entry file and supports exactly two shapes:

**One block** — `export const puckComponentDef` (category/fields/defaultProps) **plus** a default-exported render component. The block is registered under the PascalCase of your manifest `id` (`card-gallery` → `CardGallery`):

```tsx
// @ts-nocheck
"use client";

export const puckComponentDef = {
    category: "My Plugin",
    fields: {
        title: { type: "text" as const, label: "Title" }
    },
    defaultProps: { title: "Hello" }
};

export default function MyPluginPuck({ title = "" }) {
    return <section>{title}</section>;
}
```

**Multiple blocks** — a single `export const puckComponents = { ... }` where each value already includes its `render`. Detection is literal: the generator matches `export const puckComponents` in the file text and spreads the object into the registry:

```tsx
export const puckComponents = {
    PriceTable: { ...priceTableDef, render: PriceTable },
    FaqList:    { ...faqListDef,   render: FaqList },
};
```

> Export **only** the shape you use. The generated registry does `import * as X` and statically references either `X.puckComponents` **or** `X.puckComponentDef` + `X.default` — referencing a member that isn't a real export is a hard build error under Turbopack.

### 13.3 The activate → regenerate → restart flow

The registry (`frontend/src/lib/puckPluginRegistry.ts`) is **generated, not dynamic**, and includes **active plugins only**:

1. Activate the plugin in `/admin/plugins`.
2. Run `node frontend/scripts/generate-puck-plugin-registry.js`. It queries `GET /api/v1/plugins/active` on `localhost:3000` to filter — if the backend isn't reachable it falls back to including **all** plugins that have a Puck entry. Regenerate the admin-page registry too: `node frontend/scripts/generate-admin-plugin-registry.js`.
3. Restart (or let Fast Refresh reload) the frontend dev server; production needs a rebuild.

Your block then appears in the editor's component list and renders both in the editor iframe and on the live SSR site. Deactivating a plugin and regenerating removes its blocks again.

### 13.4 Theming with `--wjs-*` tokens

Blocks render inside the public site **and** the editor iframe — both load `wordjs-ui.css` plus the active theme's token block. Style your block against the tokens **with static fallbacks** so it follows any theme automatically (this is the pattern the first-party `card-gallery` / `photo-carousel` blocks use, via an embedded `<style dangerouslySetInnerHTML>` — zero build step):

```css
.my-block {
    background: var(--wjs-bg-surface, #ffffff);
    color: var(--wjs-color-text-main, #1f2937);
    border-radius: var(--wjs-radius-lg, 24px);
    box-shadow: var(--wjs-shadow, 0 4px 6px -1px rgba(0,0,0,0.1));
}
```

Two reminders for committed plugin client files: start every `.tsx` with `// @ts-nocheck` (the frontend CI type-checks the generated registries, which import these files directly from `backend/plugins/`), and mark interactive blocks `"use client"`.

> **Scaffold all of this:** `node backend/cli/wordjs.js create plugin my-plugin` generates a working single-block Puck component wired to the manifest — see `documentation/cli.md` §2.


