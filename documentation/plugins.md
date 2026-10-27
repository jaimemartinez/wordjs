# WordJS Plugin Development Guide

This guide will teach you how to create a plugin for WordJS from scratch. WordJS plugins are "full-stack": they can extend the server (API), the browser (Admin UI), and manage their own dependencies automatically.

---

## 1. The Mental Model

A WordJS plugin is simply a folder inside `backend/plugins/`.
*   **Backend (`index.js`):** Runs on the server **inside a separate OS process** (`child_process.fork`) — its own heap, event loop, and OS memory cap. It cannot `require()` core modules directly — it reaches core ONLY through the `wordjs` capability bridge, which is passed to its `init(wordjs)` function. Defines API routes, hooks, shortcodes via `wordjs.*`.
*   **Frontend (`client/`):** Runs in the user's browser. Defines the Admin interface and visual blocks for the editor. These are **build-time** React assets and are unaffected by isolation.
*   **Manifest (`manifest.json`):** The brain. Defines name, version, **`"isolated": true`** (required — non-isolated plugins are rejected), permissions, **npm dependencies**, and **frontend hooks**. Every field the runtime reads is listed in **§14 (Manifest field reference)**.

> **🔒 Isolated by default.** Every plugin runs sandboxed in its own OS process (`child_process.fork`, IPC over a structured-clone channel). There is no in-process execution path. A crash, OOM, or even a heap escape is contained to the child — the host process always survives. Your backend code talks to core only via the injected `wordjs` bridge; every bridge call is permission-checked on the host. See **§11 (The `wordjs` Capability Bridge)** below and **[Plugin Isolation](archive/plugin-isolation-proposal.md)**.

---

## 2. Tutorial: Create a "Greeting Card" Plugin

Follow these steps to create a plugin that shows a message in the admin panel. (The tutorial plugin is
called `greeting-card` so it never collides with `hello-world`, the minimal reference plugin in
`documentation/examples/plugins/hello-world/` — see [Plugins Reference §7](plugins-reference.md).)

> **Fast path:** `node backend/cli/wordjs.js create plugin my-plugin` scaffolds everything below in one command — manifest (`"isolated": true`, requested permissions), a bridge-idiomatic `index.js` (typed via `backend/types/wordjs-bridge.d.ts` for JSDoc IntelliSense), an admin page and a Verso block — and prints the activate/regenerate flow. See `documentation/cli.md` §3. The tutorial below explains what each piece is.

### Step 1: Create the Folder and Manifest
Create a folder named `greeting-card` inside `backend/plugins/`. The folder name is the plugin's
**slug**: it names its routes (`/api/v1/plugin/greeting-card/…`), its tables (`wjp_greeting_card_…`)
and its grants. Inside it, create a `manifest.json`:

```json
{
  "id": "greeting-card",
  "name": "Greeting Card",
  "version": "1.0.0",
  "description": "My first WordJS plugin",
  "author": "Your Name",
  "isolated": true,
  "permissions": [
      { "scope": "browser", "access": "script", "reason": "To run the admin page and the hooks bundle" },
      { "scope": "settings", "access": "read", "reason": "To display the site title" },
      { "scope": "express", "access": "register_route", "reason": "To serve the /message API route" },
      { "scope": "admin_menu", "access": "register", "reason": "To add the sidebar link" }
  ],
  "frontend": {
      "adminPage": {
          "entry": "client/admin/page.tsx",
          "slug": "greeting-card"
      },
      "hooks": "client/hooks.tsx"
  }
}
```

`frontend.adminPage.slug` is the page's URL segment (`/admin/plugin/greeting-card`); the sidebar item
added in Step 2 must point at exactly that path (§10.1). `id`, when present, must equal the folder name.

> **`"isolated": true` is mandatory.** A plugin without it is rejected at activation/boot
> (`Plugin '<slug>' must declare "isolated": true and use the wordjs bridge — legacy in-process plugins
> are no longer supported.`). Inside the child process you must use the `wordjs` bridge instead of `require`ing core.

> **🔥 Auto-Dependency Management:** 
> This plugin needs no npm packages. When yours does, list them in a `dependencies` object
> (`"dependencies": { "some-package": "^1.2.3" }`). WordJS reads it: when you activate the plugin, the system **automatically installs** missing packages (`npm install`). When you deactivate it, if no other plugin needs them, it **garbage collects** them (`npm uninstall`). Zero manual work.

> [!IMPORTANT]
> **Registry version ranges only.** Each `dependencies` entry must be an npm package name mapped to a
> semver **range** (`"^1.2.3"`, `"~1.0"`, `"1.x"`, `">=1 <2"`, `"*"`). Git/GitHub specs, `file:`,
> `link:`, `workspace:`, `npm:` aliases, paths, tarball URLs and dist-tags such as `latest` are
> **refused** at upload, at activation and by `npm run pack:plugin`: npm runs the `prepare` script of a
> git or `file:` dependency on the server even with `--ignore-scripts`, and an alias or URL installs code
> no one scanned under another name. A package that is not on the registry must ship inside the plugin
> (`"bundled": true`).

> [!IMPORTANT]
> **Browser code needs `browser:script`.** A plugin with any frontend entry (`frontend.adminPage`,
> `frontend.hooks`, `frontend.portalPage`, `frontend.versoComponents` / legacy `puckComponents`, `frontend.components`, the
> `client/verso/<Pascal>Verso.tsx` convention) or a prebuilt `dist/*.bundle.js` must declare
> `{ "scope": "browser", "access": "script", "reason": "…" }`. That code is **not sandboxed**: it runs in
> the admin app's origin with the viewer's session, so the administrator is asked about it explicitly,
> and the host serves the bundles only while the plugin is active and the capability is granted. Install
> and activation refuse an undeclared plugin. While the capability is not granted, the plugin's admin
> page says so and links to its permissions (`/admin/plugins?permissions=<plugin-id>`) instead of
> rendering your UI. The gate applies to the **served** bundle (`dist/admin.bundle.js`), which on a
> release is every plugin admin page: a release build (`WORDJS_HERMETIC_BUILD=1`) compiles in only the
> plugins git tracks (build it from a git checkout: without git it takes every folder on disk, and says
> so), and none of the tracked ones has an admin page. A frontend built any other way compiles admin
> pages in from plugin source (the static map `frontend/scripts/generate-admin-plugin-registry.js` writes
> before `next build` and `next dev`), and what it compiles in is part of that build:
> - **Self-built production frontend**: the plugins the backend reported active when the frontend was
>   built — or, when the generator cannot reach the backend, every plugin on disk that has an admin page.
>   Build it only with plugins you trust with the admin session.
> - **Development**: the backend re-runs the generator with the active list on every activation,
>   deactivation and deletion (`regenerateRegistry()` in `backend/src/routes/plugins.ts`, skipped when
>   `NODE_ENV=production`); test the `browser:script` gate against a release build.
>
> The same holds for hooks and Verso blocks, whose generators compile them in the same way. See
> `documentation/security.md` §1.3b.

> [!IMPORTANT]
> **Hard Lock Protection:** If your plugin requires a version of a package that conflicts with another active plugin (e.g., `lodash@^3.0.0` vs `lodash@^4.0.0`), activation will be **blocked** with a clear error message. You must either deactivate the conflicting plugin or update your dependency.

> [!IMPORTANT]
> **Declare the WordJS your plugin needs: `requires.wordjs`.** A plugin's admin screens, blocks and hooks
> import host modules (`@/components/…`, `@/contexts/…`, `@/lib/…`) that the running WordJS provides; a
> module added in one release does not exist in an older one, and a bundle that imports it shows a blank
> screen there. Declare the oldest WordJS that has everything you use, as a semver range:
>
> ```json
> "requires": { "wordjs": ">=2.10.0" }
> ```
>
> From the release that ships this check on, WordJS refuses to install or update a plugin whose range it
> does not satisfy, with 409 `core_version_too_old` (Marketplace install, update and adopt, and ZIP upload),
> and the Marketplace lists it as *Requires WordJS ≥ X — update WordJS first* with no install button. A
> malformed range is refused at upload. **Older WordJS releases ignore the field**, so it protects sites
> from this release on. `npm run build:marketplace` (`build-plugin.js`) refuses a plugin that imports a host
> module newer than the version it declares — the table is `HOST_MODULE_SINCE` in
> `backend/scripts/build-plugin.js` (`components/ui/DatePicker` → 2.10.0); add every host module you expose
> to it with the release that first ships it. When you raise `requires.wordjs`, bump the plugin's version.

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

When you package with `npm run pack:plugin` (§5) you do not ship your working `node_modules/`: the
packer installs the production dependencies into the ZIP itself.

> [!TIP]
> **When to use bundled plugins:**
> - Your plugin requires a very specific version of a popular library
> - You're distributing a plugin commercially and want zero installation conflicts
> - Your plugin has many dependencies and you want faster activation

### Step 2: Backend Entry Point (`index.js`)
Create `index.js`. Your `init` function receives the `wordjs` bridge — **use it instead of `require`ing
core**. Inside the child process there is no `express`, no `getApp()`, no direct `require('../../src/core/...')`.

```javascript
exports.init = async function (wordjs) {
    const { http, adminMenu, options } = wordjs;

    // 1. Register a JSON API route. The host namespaces it under /api/v1/plugin/greeting-card.
    //    The handler runs inside the child process with a mock (req, res) forwarded over RPC.
    //    { auth: true, admin: true } makes the HOST run its real authentication + administrator check
    //    before the request reaches your process.
    http.route('get', '/message', { auth: true, admin: true }, async (req, res) => {
        // Bridge data calls are RPCs to the host — always await them. settings:read is needed here.
        const site = await options.get('blogname', 'WordJS');
        res.json({ text: `Hello from ${site}, served by a sandboxed child process!` });
    });

    // 2. Add a link to the Sidebar (declarative — forwarded to core via the bridge). The href must be
    //    this plugin's own admin page: /admin/plugin/<frontend.adminPage.slug>. `cap` decides who sees
    //    the item; manage_options keeps it to administrators.
    await adminMenu.add({
        href: '/admin/plugin/greeting-card',
        label: 'Greeting Card',
        icon: 'fa-smile',
        order: 100,
        cap: 'manage_options'
    });

    console.log('Greeting Card plugin initialized (via the wordjs bridge)!');
};
```

> **The route is namespaced.** Every plugin's routes always mount under
> `/api/v1/plugin/<slug>/...` (so the example above is reachable at `/api/v1/plugin/greeting-card/message`).
> There is no absolute-path escape — that was removed with the trusted tier. Fetch it from your admin
> page using that namespaced URL.
>
> **Both calls are permission-checked on the host.** Without a granted `express:register_route` the
> route is dropped with a host warning; without a granted `admin_menu:register`, `adminMenu.add`
> throws (and, awaited in `init`, fails the load — which is what you want while developing). Activation
> grants what the manifest declares (§12).

### Step 3: Admin Page UI (`client/admin/page.tsx`)
Create the folder structure `client/admin/` and add `page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
// Host UI components are imported ONE FILE AT A TIME — the `@/components/ui` barrel is not one of
// the modules exposed to plugin bundles (see §4), so importing it is a build error.
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";

export default function GreetingCardAdmin() {
    const [msg, setMsg] = useState("Loading...");

    useEffect(() => {
        // The session travels in an HttpOnly cookie — `api()` sends it (credentials: 'include') and
        // prefixes /api/v1, so pass the namespaced plugin path only.
        api<{ text: string }>('/plugin/greeting-card/message')
            .then((data) => setMsg(data.text))
            .catch(() => setMsg("Failed to load"));
    }, []);

    return (
        <div className="p-8 md:p-12 h-full bg-gray-50/50 overflow-auto">
            <PageHeader 
                title="Greeting Card" 
                subtitle="My first WordJS plugin"
                icon="fa-smile"
            />
            
            <Card variant="glass">
                <h2 className="text-lg font-bold mb-4">Server Response</h2>
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

// Every export whose name starts with `register` is called when the hooks bundle loads.
export const registerGreetingCardHooks = () => {
    // The 4th argument is a stable key: registering again REPLACES the entry instead of stacking it.
    pluginHooks.addAction('user_form_before_email', (data) => (
        <div className="alert">Hello from the hook!</div>
    ), 10, 'greeting-card:user-form-note');
};
```

`user_form_before_email` is rendered by the core user forms (`<PluginHook name="user_form_before_email"
data={{ formData, setFormData, isNew }} />`), so `data` gives you the form state.

### Step 5: Build, then activate
Run `node scripts/build-plugin.js greeting-card` from `backend/` (§4), restart the backend once so it
discovers the new folder, and activate the plugin in `/admin/plugins` (§5). The **Greeting Card**
sidebar item then opens the page, which shows the message from your route.

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
node scripts/build-plugin.js greeting-card
```

The builder looks for the plugin in `backend/plugins/` by default. A plugin kept elsewhere — a
private plugin in its own repository, for instance — is built by pointing `WORDJS_PLUGINS_DIR` at
the folder that **contains** it:
```bash
WORDJS_PLUGINS_DIR=~/src/my-plugins node scripts/build-plugin.js my-plugin
```

To build **and** package in one step, use `npm run pack:plugin` (see
[§5 The Distribution Workflow](#the-distribution-workflow-standard)).

### Step 2: Verification
This script uses **esbuild** to create a `dist/` folder in your plugin with one bundle per declared
frontend entry:
- `admin.bundle.js`: Your admin UI (`frontend.adminPage.entry`).
- `component.bundle.js`: Your Verso block (`frontend.versoComponents.entry`, or the conventional `client/verso/<Pascal>Verso.tsx`; the pre-rename `frontend.puckComponents` / `client/puck/<Pascal>Puck.tsx` still resolve — see §13).
- `hooks.bundle.js`: Your frontend hooks (`frontend.hooks`).
- `portal.bundle.js`: Your public portal page (`frontend.portalPage.entry`, §10.6).
- `manifest.build.json`: Build metadata. Over HTTP (`GET /api/v1/plugins/:slug/bundle/manifest`) only its `bundles` list is served; the other fields, the version among them, stay on disk.

> A declared entry whose file is missing is a **build error**, not a skip — the build fails loudly
> instead of shipping a plugin whose UI is silently absent at runtime.

It also compiles the **Tailwind classes your UI uses** (`backend/scripts/plugin-stylesheet.js`, with the
Tailwind v4 the repository already has). A plugin loaded at runtime gets no classes from the host's
build — in development `next dev` scans `backend/plugins`, so everything looks right there, but on a
production site a class only your plugin uses would simply not exist. The compiled classes use the host's
theme, no preflight, and are **not** scoped to `.plugin-admin-<slug>` (a modal or scanner you portal to
`<body>` lives outside that wrapper):
- `admin.css`: your own `client/admin/admin.css` (if you have one), verbatim, followed by the classes
  found in `client/**` and in everything the admin bundle imports. The packers (`npm run
  pack:plugin`, `wordjs pack`, the marketplace build) ship it **as** `client/admin/admin.css`, the file the
  admin shell links (through `GET /api/v1/plugins/<slug>/admin-style/css`, for every signed-in user who
  can open your page, administrator or not); your source file is never written (building an installed copy, whose
  `client/admin/admin.css` is already a packaged sheet, keeps only its hand-written part).
- `component.bundle.css` / `hooks.bundle.css` / `portal.bundle.css`: the classes of the block / hooks /
  portal bundle only (a block's and a portal's CSS reach public pages), after any CSS esbuild extracted
  from your imports. The loader (or, for the portal, `/portal/<slug>`) links them.

Every compiled rule sits **one cascade sub-layer below the host's own** — `@layer utilities { @layer
wjs-plugin { … } }`, likewise the theme. Your sheet is linked after the host's, so a flat copy of `.flex`
or `.hidden` would beat the host's `md:hidden` on the host's own elements and turn the admin into its phone
layout on a desktop. Nested, a class the host also has keeps the host's rule and order, and a class only
your plugin uses still applies. The one consequence for your markup: on a core that did not compile your
classes, a variant only your plugin uses (`sm:text-sm`) loses to a base class the host has (`text-base`) on
the same element — where that matters, set the property with an inline style or your own admin.css (which
is unlayered and wins over every utility).

The output is deterministic — rebuilding unchanged sources gives the same bytes.

### 🛑 Critical: The React Singleton
WordJS is highly sophisticated about how it handles React. 
- **The Core Problem:** If your plugin bundles its own copy of React, Hooks will fail (Singleton violation).
- **The WordJS Solution:** The build script never lets React into your bundle. `react`, `react-dom`, `react-dom/client` and the JSX runtimes — plus a fixed list of host modules (`HOST_MODULES` in `backend/scripts/build-plugin.js`: `@/lib/api`, `@/lib/i18n`, `@/lib/plugin-hooks`, `@/lib/sanitize`, `@/lib/csrf`, the Modal/I18n/Toast/Auth contexts, `@/components/MediaPickerModal`, the `StatCard`/`PageHeader`/`Card`/`ActionCard` UI components, and the `DatePicker` calendar) — are **rewritten to the `WordJS.*` runtime globals** that `frontend/src/lib/pluginBundleLoader.ts` populates. They are deliberately **not** left as plain esbuild `external`: a bare `import … from "react"` cannot be resolved by the blob-URL module the loader evaluates. Any **other** `@/*` import — or a relative path into `frontend/src/` — is a **build error** naming the module (`Plugin imports host module "…" which is not exposed to plugin bundles`), not an external. `next/*` imports are left as plain externals, which a runtime-loaded bundle cannot resolve, so do not rely on them (read `window.location` instead of `next/navigation`, §10.6).
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
**[Plugins Reference §9](plugins-reference.md)** for the catalog.

### Getting your plugin reviewed

The catalog is open to outside authors, and the review programme is public:
**[`marketplace/REVIEW.md`](../marketplace/REVIEW.md)**. It covers what the **reviewed** badge
certifies and what it deliberately does not (§1 — it is a statement about process, not a security
audit; the sandbox below is where isolation actually lives), what a submission's `manifest.json` must
carry (§2), the checks that run automatically on the pull request (§3), the four questions a human
reviewer asks (§4), and when a review expires (§6 — any permission change invalidates it
mechanically, not by request).

Submit by opening a pull request that adds `marketplace/plugins/<slug>/`, using the
`?template=plugin-submission.md` pull-request template. A plugin the project itself maintains carries
`review.status: "first-party"`, never `"reviewed"` — see §8 on why.

### The Distribution Workflow (Standard)
This is also the way to ship a **private** plugin that never goes through the Marketplace.

1.  **Pack:** from the `backend` directory, run
    ```bash
    npm run pack:plugin -- my-plugin                          # plugin in backend/plugins/
    npm run pack:plugin -- my-plugin --dir ~/src/my-plugins   # plugin kept anywhere else
    ```
    The script (`backend/scripts/pack-plugin.js`) does what you would otherwise do by hand, and
    refuses early with the same reason the installer would give:
    - checks `manifest.json` (valid JSON, a `name`, `"isolated": true`, and an `id` — if present —
      equal to the folder name);
    - builds the frontend bundles with `build-plugin.js` (only when the manifest declares a
      `frontend` block);
    - settles the npm dependencies on its own (see
      [Dependencies in the ZIP](#dependencies-in-the-zip) below);
    - writes `release/plugins/<slug>-<version>.zip` (change it with `--out <folder>`) with a single
      `<slug>/` root folder, leaving out the top-level `data/` folder, your working `node_modules/`,
      `.git`, OS junk files and symlinks; timestamps are fixed, so the same sources give the same ZIP;
    - runs the permission check and AST scan on exactly what goes into the ZIP, and refuses a ZIP the
      upload would reject (over 10 MB, more than 5000 entries, or more than 200 MB unpacked); it
      prints the sha256.
    **From the admin screen:** while the backend runs with `NODE_ENV=development` (`npm run dev`),
    every plugin card in `/admin/plugins` has a **Build & download ZIP** button that runs the same
    packer on the installed plugin (`POST /api/v1/plugins/:slug/pack`) and saves the ZIP; a refusal
    shows its reason, and the full packer output goes to the browser console. Outside development the
    button is hidden and the route answers 404.
2.  **Upload:** Go to **Plugins** → **Upload Plugin** in the Admin panel and pick the ZIP. If that
    plugin is already installed, the screen offers to **update** it instead — see
    [Updating a plugin](#updating-a-plugin-upload-a-newer-zip) below. Nothing to deactivate or uninstall.
3.  **Activate:** Plugin works instantly using the pre-compiled bundle.

#### Dependencies in the ZIP

Nothing to choose: `pack:plugin` reads the plugin's `package.json` and code and picks the right one of
the two models the server supports (see [Bundled Plugins](#bundled-plugins-advanced)).

- **Default — the server installs them.** Your working `node_modules/` is never shipped. The
  `dependencies` of the plugin's `package.json` are merged into the packed `manifest.json`
  `dependencies`, which the server installs on activation and removes on deactivation. Keep using
  `npm install <pkg>` in the plugin folder while you develop; `devDependencies` never reach the server.
- **Bundled — the ZIP carries them.** With `"bundled": true` in the manifest, or automatically when a
  dependency is one the server refuses to install by itself (native builds such as `sharp`, `sqlite3`,
  `better-sqlite3`, `canvas`, `puppeteer`…), the packer installs the **production** dependencies fresh
  into the package (`npm ci --omit=dev` with a `package-lock.json`, otherwise `npm install --omit=dev`)
  and sets `"bundled": true`. Your plugin folder is not touched. Native binaries are built for the
  machine that packs, so pack on the same OS and CPU as the server.

Either way, every package your backend code `require()`s or `import`s (tests, `client/` and `dist/`
excluded) must be declared: a package declared nowhere stops the pack with the file that needs it,
instead of failing after upload with "Cannot find module". A package the WordJS server itself already
has only gives a warning.

Zipping by hand still works: compress the plugin folder (including `dist/`) so that it is either
the ZIP's single root folder or, with the files at the root, the ZIP is named `<slug>.zip`. Leave
`node_modules/` out unless the plugin is bundled: a non-empty `node_modules/` tells the server to skip
installing the declared dependencies.

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
- **Permissions** — every `{scope, access}` is checked against the known vocabulary; a typo (`databse`, `readwrite`) is rejected with the valid list, and so is `access: "admin"` on any scope but `email` (§12).
- **Dependencies** — only registry semver ranges (§2).
- **WordJS version** — `requires.wordjs`, when present, must be a semver range, and this WordJS must satisfy it: a plugin built for a newer WordJS is refused with 409 `core_version_too_old`, naming the version it needs (§2).
- **Browser code** — a plugin that ships any frontend entry or prebuilt bundle must declare `browser:script` (§2).
- **Admin and portal pages** — `frontend.adminPage.slug` and `frontend.portalPage.slug` must not be another installed plugin's (`Invalid admin page` / `Invalid portal page`, §10.1, §10.6).
- **Declared roles** — a `roles` block must stay inside the plugin's namespace and request `roles:declare` (§12a); anything else is rejected with the reason.
- **AST scan** — the same static scan that runs at activation runs here too; forbidden code (`eval`, `child_process`, dynamic `require`, …) is rejected up front, in your own source and — within the bounds in §7.2 — in any `node_modules/` you ship.
- **No silent overwrite** — uploading a ZIP whose plugin is already installed (active or not) is refused with 409 `plugin_exists`, which carries the installed and incoming versions; the Plugins screen turns it into the **Update** prompt below. The install path never extracts over an existing plugin.

### Updating a plugin (upload a newer ZIP)

Upload the new ZIP from **Plugins → Upload Plugin**. When the plugin is already installed, the screen
asks *Update the plugin?* with both versions; confirm and it is replaced in place
(`POST /api/v1/plugins/:slug/update`, field `plugin`). The ZIP's root folder must be the plugin's slug
(what `pack` and `pack:plugin` produce).

1. **Staged first.** The new version is extracted to a private staging directory and goes through every
   check above (bomb cap, Zip Slip, manifest, permissions, AST scan, page conflicts). A ZIP that fails is
   refused with the reason and **nothing changes** — an active plugin keeps running the old version.
2. **Then swapped.** The plugin is stopped if it was running, its code is moved aside, the staged code is
   moved in, and it is started again. If the new version fails to start, the previous one is put back
   (and restarted). An update interrupted by a crash is recovered at the next boot.
3. **Kept:** the plugin's `data/` directory (keys, attachments — a `data/` inside the ZIP is ignored when
   one exists), its `wjp_<slug>_*` tables, its stored grants and its egress allowlist.
4. **New permissions are asked about, not granted.** The answer lists `newPermissions` (declared by this
   version, not by the previous one) and `ungrantedPermissions` (declared and not granted). When there are
   any, the Plugins screen opens the plugin's permissions dialog on them; they stay off until an
   administrator grants them. A version that asks for nothing new keeps working exactly as granted.

A plugin installed from a catalog loses its catalog binding when updated by hand (its code no longer
comes from that catalog); install it from the Marketplace again to get one-click updates back. On a
multisite network, updating is the main site's job, like installing.

### Runtime health & auto-restart

Each active plugin runs in its own OS process, and WordJS now **supervises** it:

- The admin **Plugins** screen shows each plugin's live state (Running / Restarting / Crashed / Crash-looping / Stopped / Refused by the sandbox), memory (RSS), restart count, last exit code, the last error, and the child's pid.
- If a child crashes at runtime it is **auto-restarted** with exponential backoff (1s → 5s → 15s → 60s). After too many crashes in a short window it is marked **crash-looping** and left stopped (fix it and hit **Reload**).
- If the **plugin sandbox** refuses to start it — at boot, on a supervised restart or on another node — it is marked **refused** with the refusal (`runtime.lastError`, and `runtime.sandbox`: mechanism, state, the launcher's failure line, the operator action), which the screen shows in the plugin's details; it is not retried, since nothing changes until the server's sandbox is fixed. See `documentation/security.md` §1.0a.
- `GET /api/v1/plugins/:slug/status` returns that telemetry programmatically, plus the `uptimeMs` and `startedAt` the screen does not render.

### Uninstalling a plugin (and its data)

Deleting a plugin (admin **Plugins** → delete, password-confirmed) removes its folder **and** always purges its permission grants (so a later re-upload of the same slug can't silently inherit old, possibly-revoked grants) and its crash-guard strikes. To install a newer version, **update** instead (above): deleting is not needed and drops the grants.

By default your plugin's **data tables are kept** (WordPress parity). Tick **"Also delete this plugin's data / tables"** in the delete dialog to additionally `DROP` the plugin's own `wjp_<slug>_*` tables, delete the options it created, revoke the account capabilities it declared and remove its private storage. Only what belongs to the plugin goes — core settings and other plugins are never touched ([plugin-database.md](plugin-database.md#lifecycle-uninstalling-and-dropdata)).

> `wordjs.options.set` writes only options **named after your slug** (`<slug>_…`, with every run of characters other than letters and digits turned into `_`: `photo-carousel` → `photo_carousel_…`); any other name is refused. Those are the options "Also delete this plugin's data" removes. Site settings are changed on their own admin screens, never by a plugin.

---

## 6. UI Guidelines & Best Practices 🎨

WordJS enforces a **Premium Glassmorphism** design system. To ensure your plugin looks native, follow these rules:

### use `PageHeader`
Always use the standardized header component.
```tsx
<PageHeader title="My Plugin" icon="fa-bolt" />
```

### use `Card` with `rounded-[40px]`
Avoid raw `div` containers for main content. Use the `Card` component, which handles the complex border-radius (`rounded-[40px]`), shadows, and spacing for you. Its `variant` is one of `default`, `glass`, `dark` or `accent` (the last takes a `color`); it has no `title` prop — put the heading in its children.
```tsx
<Card variant="glass">
  <MyForm />
</Card>
```

### Clean Layouts
*   Use `bg-gray-50/50` for page backgrounds.
*   Use `p-8 md:p-12` for page padding.
*   Five host UI modules are exposed to plugin bundles — `PageHeader`, `Card`, `StatCard`,
    `ActionCard` and `DatePicker` (the `HOST_MODULES` list in §4). `Input`, `Select` and the rest of
    `@/components/ui` are host-only; importing one fails the build, so style your own controls with the
    same Tailwind classes instead.
*   **Dates: use the admin's calendar, not `<input type="date">`.** The native input draws the browser's
    own calendar (different per browser and OS, in the browser's language, deaf to the admin palette and
    to the editor's dark mode). Import it one file at a time like the other host components:

    ```tsx
    import { DatePicker, DateTimePicker } from "@/components/ui/DatePicker";

    <label htmlFor="ends">Ends</label>
    <DatePicker id="ends" value={endsOn} onChange={setEndsOn} min={startsOn} />          // "YYYY-MM-DD"
    <DateTimePicker ariaLabel="Opens at" value={opensAt} onChange={setOpensAt} />        // "YYYY-MM-DDTHH:mm"
    ```

    The values are exactly the native inputs' strings, so replacing an input changes nothing you store
    or send. The calendar speaks the admin language (es/en/pt), starts the week on the site's
    `start_of_week` (Settings → General), and supports min/max, Today/Clear, keyboard navigation and a
    bottom sheet on phones. Rebuild the plugin bundle after switching.
*   **Dialogs: `useModal()`, never the browser's `alert()`, `confirm()` or `prompt()`.** The native dialogs
    block the page, cannot be translated or themed, and some embedders suppress them, so the action
    silently never happens. `@/contexts/ModalContext` is a host module, and every admin screen, Verso
    component and portal page runs inside its provider:

    ```tsx
    import { useModal } from "@/contexts/ModalContext";

    const { alert, confirm, prompt } = useModal();

    await alert(t("saved"));                                                    // Promise<void>
    if (!(await confirm(t("confirmDelete"), undefined, true))) return;         // isDanger → red button; Promise<boolean>
    const to = await prompt(t("testAddress"), undefined, { inputType: "email" }); // Promise<string | null>
    if (to === null) return;                                                    // Cancel, Escape or the backdrop
    ```

    `confirm(message, title?, isDanger?, labels?)` and `alert(message, title?, labels?)` take optional
    `{ confirmText, cancelText }` labels; `prompt(message, title?, { defaultValue, placeholder, inputType,
    confirmText, cancelText })` takes `inputType` `"text"` (default), `"email"`, `"url"` or `"number"`; its text
    box starts with `defaultValue`, and OK resolves to what is in it. Titles and buttons default to the
    reader's language. For a notice that needs no answer, prefer a toast (`useToast()` from
    `@/contexts/ToastContext`).

    **This is enforced.** `frontend/src/lib/__tests__/noNativeDialogs.test.ts` scans every file under
    `marketplace/plugins/**` (and the core's frontend, public assets, themes and gateway) with scope
    analysis: a `confirm` destructured from `useModal()` passes, while `confirm(…)`, `window.confirm(…)`,
    `globalThis.prompt(…)`, an inline `onclick="return confirm(…)"` or a `<script>` in an `.html` file
    fails the suite. An `eslint-disable` comment does not hide a call, and a file the scanner cannot parse
    is a finding too. Run it before you open a pull request:

    ```bash
    cd frontend && npx vitest run src/lib/__tests__/noNativeDialogs.test.ts
    ```

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
dot-dirs and the browser-only `client/`, `frontend/` and `dist/` folders, and taking a shipped
`node_modules/` in a bounded pass of its own (see below) — and blocks the plugin if it finds:
*   A call whose callee is named `eval`, `Function`, `exec`, `execSync`, `spawn` or `fork`. The match is
    on the **name**, so `anything.spawn()` trips it too. The only exemption is `.exec()` on something
    *provably* a RegExp — a regex literal (`/re/.exec(s)`) or an identifier bound by `const NAME = /re/`
    — which is `RegExp.prototype.exec`, not `child_process`. A `let`/`var` binding or a computed
    initialiser stays flagged, because it could hold something else by the time it is called.
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
    hard block. What clears them is a `network` entry — the scope-only `{ "scope": "network" }` form §12
    documents, matched on scope alone — or an `email: admin` entry, declared in the manifest and (outside
    a declaration-only check) granted by the admin.
    A non-literal specifier (`require(x)`, `import('child'+'_process')`) is itself flagged as
    obfuscation.
*   Undeclared capabilities inferred from the code: `fs.readFileSync`/`fs.writeFile`/… require
    `filesystem:read`/`write` in your manifest, and `getOption`/`updateOption`/`dbAsync` require the
    matching `settings`/`database` access. The fs check resolves the **value** the callee evaluates to,
    so an alias, a destructured method, `require('fs').x()` and a helper that returns the module are all
    one fact; and it fails closed — an fs value the resolver cannot follow to a call site (passed to a
    function, exported, stored on `this`) is **charged** the permission instead of ignored. A
    read-named method (`readFileSync`, `readFile`, `createReadStream`, `existsSync`, `statSync`) costs
    `filesystem:read`, anything else `filesystem:write`. A bare `require('fs')` bound to a local you
    never use is still not a violation.

**Your shipped `node_modules/` is scanned too.** A dependency tree you ship inside the plugin (see
*Bundled Plugins* in §2) is walked in a pass of its own, bounded so that a huge tree cannot turn a boot
into a multi-minute AST run: at most **4,000** files, nothing larger than **1 MB** each, no deeper than
**32** levels, `.js`/`.cjs`/`.mjs` only, and no symlink followed outside your plugin directory (every
path is realpath-checked, and one that escapes is refused *and* counted). Hitting one of those bounds is
itself **reported as a finding**, not a pass — the plugin is blocked with `node_modules/: the shipped
dependency tree could not be scanned in full …`, a message that ends by telling you to ship fewer and
smaller dependencies *or* to stop shipping `node_modules/` — leaving `"bundled"` unset — and declare
the packages in your manifest's `dependencies`, so the host installs them from the registry. Findings
from a dependency file are prefixed with that file's path, and the detector is deliberately
**re-calibrated** inside one.
Kept, because they have no benign reading in third-party code:
`eval`/`Function` matched by name, indirect `(0, eval)(x)`, `(…).constructor('…')` and
`const F = [].constructor.constructor`, `require`/`import` of a sensitive builtin, and the four
native-binding `process` escapes — `binding`, `_linkedBinding`, `dlopen`, `getBuiltinModule`. Dropped,
because they would fire on nearly every package: the **name**-matched `exec`/`execSync`/`spawn`/`fork`
sinks (`re.exec(s)`, `emitter.fork()` — the way a dependency actually reaches `child_process` is the
`require`/`import` above, which is still caught), computed `require()`/`import()` and computed member
calls, every `process` property outside those four (`process.platform`, `process.cwd()`,
`process.nextTick`), reads of `global`/`globalThis`/`require`/`module`, obfuscated computed access on
them, and aliasing anything but `eval`/`Function`. Downgraded rather than dropped: filesystem and
host-API charges are not collected from dependencies at all (io-guard gates every `fs` call against
*your* grants at the call itself, and a bare `getOption` inside a third-party package is a name
collision, not a call into WordJS), and a dependency's **networking** builtins — `secure-require`'s own
`NETWORK_MODULES`, so `net`/`dns` *and* `http`/`https`/`dgram` — stay a fixable *missing capability*
rather than a hard block, because the runtime already gates exactly those on your Network grant. Runtime
containment (secure-require, io-guard, the worker's ESM hook, `blockCodeGen`) is still what actually
stops a dependency at runtime; this pass buys you a look at what you are shipping.

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
only); (b) a **default-on preventive Windows Job Object** assigned before the child resumes; (c) a
**reactive** host-side RSS poll on every platform (Linux `/proc`, Windows `tasklist`, macOS `ps`) that
`SIGKILL`s a child whose resident set exceeds **768 MB**; (d) a loose Linux `RLIMIT_AS` virtual backstop
(`config.sandbox.addressSpaceCapMb`, default 16384 MB) plus `--max-old-space-size=256` for the JS heap.
Current macOS does not enforce its `RLIMIT_AS` alias, so WordJS detects and rejects that false cap; its
remaining layers are the V8 heap ceiling, separate process and reactive RSS poll.

**CPU and kernel tables are capped too.** When the cgroup scope in (a) is on, it also carries
`MemorySwapMax=0` and `TasksMax=512` — so a fork/thread-bomb exhausts your **own** cgroup, not the host
task table — and, if the operator sets **`config.sandbox.cpuQuotaPercent`** (**opt-in**, default `0` =
off), a `CPUQuota=N%` cap where 100 = one full core, so a runaway plugin cannot peg every core. The CPU
quota only takes effect **together with** `useCgroupMemoryCap`: both share one `systemd --user` scope and
the probe validates that exact property set before the mode activates, so enabling it on a host whose
`cpu` controller is not delegated falls back to the normal launch instead of failing to start. On the
non-cgroup Linux path the child also gets `RLIMIT_NOFILE=4096` alongside the `RLIMIT_AS` backstop.

Because that quota is opt-in — and the very same knob is what installs the **Windows** Job Object CPU-rate
cap, likewise off at `0` — every path with no preventive CPU cap actually installed (Windows without
`cpuQuotaPercent`, a plain Linux launch, macOS, a host whose cgroup probe failed) gets a **default-on
reactive CPU watchdog** instead.
The host-side poll that already reads the child's rss also samples its cumulative CPU time, and a child
holding **≥ 95% of one core for `config.sandbox.cpuBurstSeconds` (default `60`, `0` disables) with no
quiet tick** is `SIGKILL`ed, with the reason recorded on the plugin's health surface. A single tick below
the threshold resets the window, so bursty-but-honest work (an import, a thumbnail batch, a sitemap
rebuild) is untouched. It samples Linux `/proc/<pid>/stat`, macOS `ps -o cputime=` and, on Windows, the
`CPU Time` column of `tasklist /V` — sampled every 30 s because of its 1-second resolution, so a Windows kill lands within about one and a half windows; it stands down only where a preventive cap **is** installed — Windows
with `cpuQuotaPercent > 0` (Job Object rate control) or cgroup mode with the same knob set. **Cgroup mode
without a quota is the one configuration with no CPU bound at all** (`child.pid` is `systemd-run` there,
not the plugin, as for the RSS poll); the server warns once at launch naming the knob.

**Network egress:** by default you get **no outbound network**. The raw socket modules
(`net`/`tls`/`dgram`/`http`/`https`/`http2`/`dns`) are denied, and the globals `fetch` / `WebSocket` /
`EventSource` are trapped (they throw). The raw resolver stays denied even *with* `network` (it would
bypass egress filtering), so MX/TXT lookups go through the host-mediated `wordjs.dns.*` bridge in §11.
Outbound access opens **only** when an admin grants your plugin
the **`network`** capability (declare `scope: "network"` in your manifest; the grant carries an
exfiltration warning). This is the only network path — there is no trusted tier that bypasses it.

**TCP ports.** With `network`, the kernel sandbox lets your plugin connect only to DNS (53) and the web (80, 443)
over TCP — on Linux with Landlock (kernel 6.7 or later) and on macOS with Seatbelt, which also keeps loopback out
of reach. Name any other port your plugin needs on the same permission, and the administrator grants it with it:
`{ "scope": "network", "ports": [25, 587], "reason": "…" }` (at most 16 ports, 1–65535). A private destination an
administrator approves (`host:port`) adds its own port. On Windows, a Windows Firewall rule on each plugin's sandbox refuses the
private networks except the hosts approved for it (Site Health adds the rules; Windows asks for an administrator).

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
The child's working directory is the **filesystem root** on macOS and on the ordinary Linux launch, so
`process.cwd()` there discloses nothing about where the site is deployed (the opt-in systemd-scope path —
`sandbox.useCgroupMemoryCap`/`cpuQuotaPercent` — still inherits the server's directory). Never resolve a
path against the cwd; `wordjs.fs.read`/`write` paths are relative to your own plugin directory.

> ⚠️ **Residual risk and native boundary:** every production plugin is wrapped by a probe-certified
> native sandbox: Landlock + an always-on seccomp filter on Linux, AppContainer on Windows, and Seatbelt
> on macOS. These mechanisms remain active for network-granted plugins; the grant changes only the
> kernel egress rule. `sandbox.requireHardening` is true by default, so a missing mechanism or a failed
> per-plugin launch refuses the plugin. Only an explicit `requireHardening:false` permits the weaker
> compatibility fallback. Node's permission model and the JavaScript guards remain defense-in-depth.
> The honest remaining platform difference is preventive resident-memory enforcement: Windows has a Job
> Object and systemd Linux can use cgroup v2, while macOS relies on process separation, the V8 heap cap
> and a reactive RSS poll. The sandbox has not had an independent external audit.
> See **[Plugin Isolation](archive/plugin-isolation-proposal.md)** — read its status banner for the as-built
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
| `client/verso/`         | Visual blocks for the Page Builder.             |
| `public/`               | **The only part of your plugin the web server publishes.** Put every browser-fetched asset here. Read-only to your own code at runtime — see §11a. |

---

## 9. Developer Rules of Gold 🏆

1.  **Auth First:** Call your routes through `api()` from `@/lib/api` — the session is an HttpOnly cookie, so a raw `fetch` needs `credentials: 'include'` and there is no bearer token in `localStorage` to read. Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` also carry a double-submit CSRF token: `api()` attaches it for you, while a raw `fetch` must send `X-CSRF-Token` equal to the JS-readable `wjs_csrf` cookie or the request is refused with `403 rest_csrf_token`. Your own routes under `/api/v1/plugin/<slug>/…` sit behind that same gate.
2.  **Use the bridge, not `require`:** In `index.js`, accept `init(wordjs)` and call `wordjs.*`. You **cannot** `require('../../src/core/...')`, `express`, or core modules from inside the child process — that path is gone.
3.  **Declare `"isolated": true`:** It is mandatory; a plugin without it is rejected.
4.  **Namespaced routes:** Your routes mount under `/api/v1/plugin/<slug>/...` — fetch them at that path.
5.  **Unique Slugs:** Ensure your plugin folder name and slug are unique.
6.  **No browser dialogs:** `alert()`, `confirm()` and `prompt()` are forbidden in every plugin file; use `useModal()` from `@/contexts/ModalContext` (§6). A repository test fails the build otherwise.

---

## 10. Advanced Features

### 10.1 Admin Menus & Deduplication ⚠️
WordJS's frontend (`Sidebar.tsx`) automatically **deduplicates** menu items.
*   **Core Items:** Dashboard, Media, Posts, Settings, etc., are defined in the frontend
    (`frontend/src/lib/adminAccess.ts`, the same map the admin route guard enforces).
*   **Plugin Items:** Fetched from the backend (`GET /plugins/menus`, filtered by each item's `cap`).

**Your menu item is also the key to your page.** The admin layout lets a non-administrator open
`/admin/plugin/<slug>` only when they have a menu item pointing there, so give the item the capability
your page needs (for a plugin role, one of your own namespaced capabilities — §12a). A plugin menu item
never opens a core screen: `/admin/users` stays `list_users`-only whatever capability your item names.
Administrators open every page. A plugin's item may point only at **its own** admin page
(`/admin/plugin/<frontend.adminPage.slug>`): an item pointing at another plugin's page is dropped with a
host warning, so one plugin's roles can never open another plugin's screen. What is installed decides
whose page a slug is — the plugin installed in the folder of that name, otherwise the one installed plugin
whose manifest declares it — never your manifest alone, and the upload and the activation refuse an
`adminPage.slug` that is another installed plugin's folder or admin page (`Invalid admin page`), as they
refuse a plugin whose folder another installed plugin declares as its admin page. This guard is
navigation in the browser, not access control — your routes must still check the caller (§12a).

If your plugin registers a menu item with the same path as a core item (e.g., `/admin/media`), the frontend will **hide** your plugin's item to prevent React duplicate key errors.
Always use unique paths (e.g., `/admin/plugin/my-plugin-media`) unless you intentionally want to rely on the core item.

**Use `plugin: 'core'` filtering:**
The backend marks standard menus with `plugin: 'core'`. The frontend filters these out from the dynamic list.

### 10.2 Widgets API
A plugin registers sidebar widgets with `wordjs.widgets.register(id, def)`. They appear in **Appearance →
Widgets**, where an administrator drops them into a sidebar and fills in the settings form `fields`
declares; `render(settings)` runs in the plugin's sandbox and returns the widget's HTML:

```javascript
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

exports.init = (wordjs) => {
    wordjs.widgets.register('my_weather', {
        name: 'Weather',
        description: 'Shows the local weather',
        // The instance settings form. Types: text, textarea, html, number (min/max), checkbox.
        fields: [
            { name: 'title', label: 'Title', type: 'text' },
            { name: 'city', label: 'City', type: 'text', default: 'Lima' },
        ],
        render: async (settings) => `<div class="weather">Sunny in ${escapeHtml(settings.city)}</div>`,
    });
};
```

- Only the declared fields are stored, coerced to their type and bounded; `title` is printed (escaped)
  above the widget by the sidebar. Escape whatever else you interpolate: the public site sanitizes the
  sidebar HTML, but your output should not rely on it.
- `render` is capped at 2 s, like a shortcode: a slow or crashed child renders the widget empty, never
  holds the page.
- Ids are letters, digits, `_` and `-` (64 at most), at most 50 widgets per plugin. An id that core or
  another plugin already registered is refused (the core `text`, `recent_posts`, `categories`, `search`
  and `custom_html` widgets cannot be replaced). Widgets are registered per site and disappear when the
  plugin is deactivated; the instances placed in sidebars render nothing until it is back.
- No permission is needed to register a widget; what `render` reads goes through the bridge and its
  own grants (e.g. `settings:read` for `wordjs.options.get`).

Core code (not a plugin) registers widgets with `registerWidget(id, name, { description, fields, render })`
from `backend/src/core/widgets.ts` — see [api.md §12](api.md#12-widgets-system-).

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

**Using Filters (Modify something):** the filter core applies that a plugin may join is
`comments:pre_insert`, the anti-spam / captcha extension point of `POST /comments`
(`backend/src/routes/comments.ts`). It needs `{ "scope": "comments", "access": "read" }` declared and
granted. Your callback receives the verdict (`true`) and a plain description of the comment about to be
written (`postId`, `author`, `authorUrl`, `content`, `status`, `parent`, `userId`, `isAuthenticated`;
`authorEmail`, `authorIp` and `agent` only with `comments:pii`):
```javascript
exports.init = function (wordjs) {
    wordjs.hooks.addFilter('comments:pre_insert', (verdict, comment) => {
        const links = (String(comment.content || '').match(/https?:\/\//g) || []).length;
        // false = discard the comment exactly as a tripped honeypot does (the commenter is told nothing).
        return links > 3 ? false : verdict;
    });
};
```
Return `false` to discard; anything else lets the insert proceed. A callback that throws or does not
answer within 2 seconds leaves the value unchanged, so the comment is written.

A filter name core never applies is simply never called. `the_content`, for instance, is not applied by
the backend (the public site is rendered by the Next.js frontend): registering it is accepted, as one of
your own hook names, and does nothing.

**Which hooks you may subscribe to.** A subscription is a *read* of everything the hook carries
(the host serializes its arguments into your process), so core hooks follow the host's hook access
policy (`backend/src/core/hook-access.ts`; full table in [security.md §8.1](security.md)):

| Hooks | Permission you must declare (and the admin grant) | What you receive |
| :-- | :-- | :-- |
| `init`, `activated_plugin`, `deactivated_plugin`, `switch_theme`, `registered_*` | — | As fired. |
| `wp_insert_comment`, `deleted_comment`, `comments:pre_insert` | `comments:read` | The comment **without** `authorEmail`, `authorIp`, `agent` — add `comments:pii` to receive those (anti-spam). |
| `wp_insert_post`, `post_updated`, `deleted_post` | `posts:read` | Post data including drafts/private posts; never the post password. |
| `notification_sent` | `notifications:read` | The notification with tokens, codes and reset/verification text redacted. |
| `updated_option` | `settings:read` | Name and value; secret and protected option values arrive as `'[redacted]'`. |
| `wordjs_head`, `wordjs_footer`, `wp_head`, `wp_footer`, `dynamic_sidebar`, `admin_menu_items`, core cron hooks | denied to every plugin | — |

**Filters that fail closed.** For most filters, a callback of yours that throws or does not answer within
2 s is skipped: the value goes on unchanged, so a broken plugin cannot break the page. `comments:pre_insert`
is the exception, because it is a verdict: a callback that throws (or times out) **refuses the comment**.
Throw an error with a 4xx `status` and a `rest_*` `code` to refuse with your own answer (e.g.
`422 rest_captcha_required`); any other failure is answered as `503 rest_plugin_check_failed`, without
your error text. Return `false` to discard the comment silently as spam.

Your **own** hook names need no permission. Names in a core namespace that core does not define
(`wp_*`, `wordjs_*`, `core:*`, `comments:*`, `posts:*`, `users:*`, …) are reserved and refused. A refused
subscription is dropped and the host logs `denied hook subscription: … requires the <scope:access>
permission`. Grants are re-checked on every delivery, so a revoke takes effect immediately.

**Debugging Hooks:**
You can use the **Hooks Registry** in the Admin Panel (`/admin/hooks`) to:
1.  **Inspect:** See exactly which hooks are registered and by whom.
2.  **Live Monitor:** Watch events fire in real-time to debug timing issues.

### 10.6 Portal pages (`/portal/<slug>`) 🚪

A plugin can ship **one standalone public page** for people who are not WordJS users — a conference's
coordinators, a vendor, a field team opening a QR link. Declare it in the manifest:

```json
"frontend": {
    "portalPage": {
        "entry": "client/portal/page.tsx",
        "slug": "my-portal",
        "title": "My portal",
        "themeColor": "#2563eb",
        "viewportFit": "cover"
    }
}
```

- **`slug`** (required) — the page is served at `/portal/<slug>` and every path below it. One lowercase URL segment
  (`a-z`, `0-9`, inner hyphens, at most 64 characters). It belongs to **one** installed plugin: the upload
  and the activation refuse a slug another installed plugin already declares (`Invalid portal page`).
- **`entry`** (required) — a `.tsx`/`.ts`/`.jsx`/`.js` file under `client/`, starting with `"use client"`
  like an admin page (§2 Step 3). Its default export is a
  React component; it receives `{ slug, path }` — `path` being the segments after the slug, so
  `/portal/my-portal/rsvp` renders the same component with `path: ["rsvp"]` (`[]` at the portal root) and
  the plugin can keep sub-pages under its slug. It reads the rest of the URL itself — the query string and
  the hash reach it untouched (`window.location.search`, e.g. `/portal/my-portal?code=123456` for a QR
  link). `next/navigation` is not available to a runtime bundle; use `window.location`. An unknown
  sub-path is the plugin's to answer.
- **`title`**, **`themeColor`**, **`viewportFit`** (optional) — the page's `<title>`, `<meta
  name="theme-color">` (a hex colour) and `viewport-fit` (`auto`, `cover` or `contain`). Use `cover` only
  if your page pads itself with `env(safe-area-inset-*)`: it lets the page draw under a phone's notch.
  Portals are always `noindex`.
- **`pages`** (optional) — the `<head>` of sub-pages, keyed by their first path segment:
  `{ "me": { "title": "My page", "private": true, "app": { "name": "My page", "shortName"?, "description"?,
  "backgroundColor"?, "themeColor"? } } }` (at most 20). `title` replaces the portal's; `private` marks a personal
  page — never indexed, never stored by a cache, and no `Referer` leaves it (a link or a map tile that needs one
  opts in itself); `app` makes the sub-page installable to a phone's home screen (what an iPhone needs before it
  delivers Web Push): the core serves its web app manifest at `/portal/<slug>/app.webmanifest?page=me`, scoped to
  `/portal/<slug>/me`. Hex colours only; no `<` or `>` in a text.
- **`serviceWorker`** (optional) — a plain `.js` file under `client/` (`"client/portal/sw.js"`), served as-is
  (never compiled) at `/portal/<slug>/sw.js`, so a page of the portal can register it with the portal or one of its
  sub-pages as its scope — e.g. to show notifications sent by Web Push. Sending them needs the `network` grant.
- **`file`** (optional) — one of your PUBLIC GET routes (`"/public/file"`) that turns a short-lived ticket you mint
  (`?d=`, 16–128 letters, digits, `-` or `_`) into `{ mime, filename, b64 }`. A plugin route answers JSON; the core
  answers the bytes at `/portal/<slug>/file?d=<ticket>` with their real type — a PDF opens in a phone's viewer —
  for `application/pdf`, `image/png` and `image/jpeg` only, `no-store`, `nosniff`. The ticket is the only
  credential: make it random, short-lived and few-use.
- The core's own paths under every portal — `/portal/<slug>/file`, `/sw.js` and `/app.webmanifest` — are never
  your sub-pages (`file` is refused as a `pages` key).

**What the page gets.** The bare portal layout — no theme header or footer, no admin shell — with
`ModalProvider`, `I18nProvider` and `ToastProvider` mounted, so `useModal()`, `useI18n()` and `useToast()`
work. **Never call the browser's own `alert()`, `confirm()` or `prompt()`** (nor `window.*`): use
`useModal()` (its `alert`, `confirm` and `prompt` are described in §6) or a toast — the repository test
`noNativeDialogs.test.ts` fails on a native dialog in a portal as anywhere else. The page may import the same host modules as an admin page (`@/lib/api`, `@/lib/csrf`,
`@/contexts/ToastContext`, …); a portal that posts with its own `fetch` must spread `csrfHeaders()` from
`@/lib/csrf` into a mutating request that carries cookies. Your own look is your own: copy the UI
primitives you want into your plugin rather than importing another plugin's.

**How it is served.** Like every other frontend entry, it needs `browser:script`. The build compiles it to
`dist/portal.bundle.js` and its Tailwind classes to `dist/portal.bundle.css` (§4). The frontend's server
page asks `GET /api/v1/plugins/<slug>/portal` first: it answers only for an **active** plugin granted
`browser:script` (otherwise the page is a real `404`), with the optional head details above. The page
then renders your component — compiled in when the plugin was present at build time
(`frontend/scripts/generate-portal-plugin-registry.js`), otherwise loaded at runtime from
`GET /api/v1/plugins/<slug>/bundle?type=portal` — and links `…/bundle/css?type=portal`. All three routes
take the **portal** slug, never the folder or the admin-page slug. A static folder under
`frontend/src/app/portal/` is a core route of its own and wins over a plugin portal of the same name. The menu
editor (`/admin/menus`, «System pages») offers every portal that is served (`GET /plugins/portals`).

The conference-manager plugin's portal is the complete example: `/portal/conference` (the coordinators), its
sub-pages `yo` (private, installable, with a service worker for its bus notices) and `badge`, and its badge PDFs
through `file` — see `marketplace/plugins/conference-manager/manifest.json` and `client/portal/page.tsx`.

---

## 11. The `wordjs` Capability Bridge (reference)

`init(wordjs)` receives this object. Data methods are **async** (they cross the child→host IPC boundary).
Every call is permission-checked on the host against your manifest.

| Bridge call | Permission | Notes |
| :--- | :--- | :--- |
| `wordjs.options.get(key, default)` / `set(key, value)` | `settings:read` / `write` | `set` writes only `<slug>_…` options (see above). Secret-named keys (`*secret*`, `*password*`, `*key*`, `*token*`, `dkim`, certs…) are **never** exposed — to any plugin. |
| `wordjs.db.all(sql, params)` / `get(...)` / `run(...)` | `database:read` / `write` | Always scoped to your own `wjp_<slug>_` tables; SQL referencing core tables (`users`, `options`, `sessions`, …) is rejected. There is no unscoped mode. DDL is limited to your OWN `TABLE`/`INDEX`/`VIEW`/`TRIGGER` (SCHEMA/DATABASE/ROLE/FUNCTION/EXTENSION/… denied), an `ALTER … RENAME TO` target must keep your prefix, and a data-modifying `WITH` (a CTE containing insert/update/delete/replace/merge) counts as a write and needs `database:write`. |
| `wordjs.db.batch(statements)` | `database:read` / `write` | Up to 200 `[sql, params]` pairs in ONE host round-trip — a transport optimisation only: each statement is re-checked with the same permission + SQL guard as the single-statement call, and DDL is refused (use `db.run` / `db.createTable`). Validated as a whole before anything runs, but **not** a transaction — a mid-batch failure leaves the earlier statements applied. |
| `wordjs.db.createTable(name, columns)` | `database:write` | Does **not** add the prefix for you: `name` must already start with `wordjs.db.tablePrefix`, or the call throws (`Plugin tables must be named with the 'wjp_<slug>_' prefix`). Build it as `wordjs.db.tablePrefix + 'items'`. Emits `CREATE TABLE IF NOT EXISTS` and records your plugin as the table's creator. |
| `wordjs.db.tablePrefix` | — | A plain string property, not an RPC: `wjp_` + your slug with every run of non-alphanumerics turned into `_`, lowercased, + `_` (`greeting-card` → `wjp_greeting_card_`). |
| `wordjs.slug` | — | Your plugin's slug (its folder name). |
| `path.join(__dirname, 'data', …)` | — (no grant needed) | **Your own data folder**, writable with no permission: your code folder is read-only to your plugin at every sandbox layer, and `data/` in it is a link to `backend/data/plugin-own/<key>` (a junction on Windows), created on the plugin's first start — an existing `data/` folder is moved there with everything in it. Write state there; a write anywhere else in your code folder is refused. The code and `manifest.json` are fingerprinted and checked before each start, so a plugin is not started with files changed after it was installed (an administrator can accept such files in Site Health). |
| `wordjs.paths.data` / `.logs` / `.tmp` | — (raw `fs` on them needs `filesystem:read` / `write`) | Frozen absolute paths of your plugin's private storage directories (`backend/data/plugins/<key>`, `backend/logs/plugins/<key>`, `backend/os-tmp/plugins/<key>`, `<key>` derived from the slug) — a directory of your own under each shared root, never the root itself. They are created when the plugin holds a `filesystem` grant. |
| `wordjs.db.getType()` | `database:read` | Returns `{ isPostgres, isMySQL, isSQLite, driver }` (`driver` is the full driver name, e.g. `'sqlite-native'`, `'sqlite-legacy'`, `'postgres'`, `'mysql'`, or `'mariadb'`) — branch your DDL on the `isPostgres`/`isMySQL` booleans rather than the raw `driver` string (`isMySQL` is `true` for both `'mysql'` and `'mariadb'`). Note `isSQLite` stays `true` under MySQL (the MySQL driver translates the SQLite dialect), so gate SQLite-only queries (`PRAGMA`/`sqlite_master`) on `isMySQL` explicitly. |
| `wordjs.users.findByEmail / findByLogin / findById / search(...)` | `users:read` | **Safe projection** only: `{ id, userLogin, username, userEmail, displayName, role, pluginCapabilities, accountCapabilities }` — never `user_pass` or other credential fields. `pluginCapabilities` is the account's capabilities in your own namespace (§12a), the same list a route gets as `req.user.pluginCapabilities`; `accountCapabilities` is the account's admin-owned grants among the capabilities you declare (§12b) — read them, never re-derive a grant from `userEmail`, which the account itself can write. The sanctioned way to read users without core-table access. |
| `wordjs.site.url / domain / adminEmail` | `settings:read` | Read-only site identity. |
| `wordjs.media.getPrivate(id)` · `res.sendPrivateMedia(id, { filename })` | `media:private_read` | PRIVATE media (`documentation/security.md` §1.5). `getPrivate` returns `{ id, title, mimeType, filesize, filename }` (never a path) or `null`; replying with `res.sendPrivateMedia` from one of your routes makes the HOST stream that file as a download (`no-store`, attachment). Your route decides who may download (e.g. a paid, unexpired token); the file never gets a public URL. Without the grant the call throws and the reply is `403`. |
| `wordjs.dns.resolveMx / resolveTxt / resolve4 / resolve6 / resolve(...)` | `network` | Host-mediated DNS. The raw resolver (`dns.resolve*`) is denied inside the child, so MX (direct delivery) and TXT (SPF/DKIM/DMARC) lookups go through here. The host strips every A/AAAA answer pointing at a private/internal address, so the address lookups return public IPs only. The name being resolved must be inside the plugin's egress allowlist when one is set, and a name containing a control character (a NUL, which the resolver would stop at) is always refused. |
| `wordjs.hooks.addAction/addFilter(hook, cb, priority)` · `doAction(hook, ...args)` | — | Callback runs in the child process; host installs an RPC shim. Core hooks that carry other parties' data need the matching grant — `comments:read` (`comments:pii` for commenter email/IP/agent), `posts:read`, `notifications:read`, `settings:read` — and arrive minimized (see §10.5); reserved core-namespace names are refused. Raw-HTML output hooks — `wordjs_head`/`wordjs_footer` and their WordPress-compat aliases `wp_head`/`wp_footer` and `dynamic_sidebar` — are denied to every plugin (the registration is dropped with a host-side warning; no trust tier exempts anyone). `doAction` fires only your OWN registered callbacks — never core's or another plugin's. |
| `wordjs.http.route(method, path, [opts,] handler)` | `express:register_route` | Mounted at `/api/v1/plugin/<slug>/path` (always namespaced — no absolute mode). The host checks the grant on every registration: without a granted `express:register_route` the route is dropped with a host warning (`denied route registration: express:register_route not granted`) and nothing is mounted — `access: "admin"` does NOT imply it, declare it explicitly. `opts`: `{ auth, admin }` (host runs the real auth middleware), `{ multipart: 'field' }`. Handler gets a mock `(req,res)` over RPC. `req` carries `method`, `path`, `query`, `params`, `body`, plus `clientKey` (a stable HMAC of the caller's IP — rate-limit or dedup by caller without seeing the IP), `cookies` (the host's auth/session cookies always stripped), `headers` (only `x-portal-token` is forwarded) and, for a `multipart` route, `file` (`{ path, originalname, mimetype, size, filename }` of the saved upload: staged in your own private tmp storage, readable by your plugin without a `filesystem` grant, and removed when the response finishes — copy it during the request if you need it later). With `auth`, `req.user` is `{ id, role, pluginCapabilities, accountCapabilities }`, plus `userEmail` and `userLogin` only when the plugin holds the **`users:read` grant** (they are personal data) — `pluginCapabilities` being the caller's capabilities in your own namespace (§12a); `null` for an anonymous request. `res` offers `status`, `set` (headers — `Set-Cookie`, CSP, HSTS, `Location`, `Content-Type`, `Refresh` and `Access-Control-*` are dropped by the host), `cookie` / `clearCookie` (renamed into your `wjp_<slug>_` namespace, path-confined to your routes, lifetime capped at 7 days, at most 20 per reply), `json`, `send`, `end`, and `sendPrivateMedia` (row above). |
| `wordjs.shortcodes.add(tag, handler)` | — | Handler may be async; expanded via `doShortcodeAsync`. |
| `wordjs.widgets.register(id, { name, description, fields, render })` | — | A sidebar widget; `render(settings)` may be async, capped at 2 s ([§10.2](#102-widgets-api)). |
| `wordjs.graphql.extend({ typeDefs, fields })` | — (its routes need `express:register_route`) | Adds GraphQL types and `Query` fields, each resolved by one of your own GET routes called as the GraphQL caller ([graphql.md](graphql.md#extending-the-schema)). |
| `wordjs.fs.read(relPath, enc)` / `write(relPath, data)` | `filesystem:read` / `write` | Confined to your **own** plugin dir only (realpath-checked) — never the shared `uploads/` dir. `manifest.json` is immutable, and so is everything under `public/` and `dist/` (§11a). |
| `wordjs.mail(msg)` | `email:admin` | Sends via the active mail provider. (Distinct from `email:provider`, which only `wordjs.provideMail` needs.) |
| `wordjs.provideMail(handler)` | `email:provider` | Become the host-wide mail sender (sandboxed; needs the `email:provider` grant, shown to the administrator as **administrator-level**). Password-reset and verification email reaches your provider only if the administrator allows your plugin by name in Settings → Account email; by default the host sends it with its built-in SMTP transport. |
| `wordjs.notify(n)` | `notifications:send` | Push an admin notification. |
| `wordjs.ai.complete({ prompt, system?, maxTokens? })` | `ai:use` | Text completion through the site's AI provider → `{ text, model }`. The key never reaches the plugin; 30 calls/minute (`ai-provider.md` §4). |
| `wordjs.notify.registerTransport(name, handler)` | `notifications:provider` | Register a notification transport (sandboxed; needs the `notifications:provider` grant, shown as **administrator-level**: the transport receives the full content of what it delivers). |
| `wordjs.smtp.listen(handlers, opts)` / `wordjs.smtp.status()` | `smtp:inbound` | Have the HOST listen on the SMTP port (a `claimPorts` entry, default 25; falls back to 2525 with the reason recorded) and call `handlers.connect/mailFrom/rcptTo/data/close` for each step — resolve nothing to accept or `{ code, message }` to refuse; `data` receives the raw message as a Buffer. The host bounds what senders can make it hold: every message in progress — its bytes and the copy handed to the plugin — counts against one in-flight budget (`opts.maxInflightBytes`, default 256 MB, never less than three maximum-size messages), and a message that would exceed it is answered `452` (the sender retries later); one client address may hold `opts.maxClientsPerIp` connections (default 10), and more are answered `421`. The host does no reverse-DNS lookup per connection: `session.clientHostname` is the address literal (`[203.0.113.9]`). **Exclusive:** at most one plugin may hold `smtp:inbound` (a second grant is refused with `409 plugin_grant_exclusive` naming the holder). Plugins never get a listening socket themselves on any platform. |
| `wordjs.adminMenu.add(item)` | `admin_menu:register` | Declarative sidebar item. Gated host-side like every other bridge call: the manifest must declare `admin_menu:register` **and** the admin must grant it, or the call throws a `Security Block` (`access: "admin"` does not imply it). `item.href` must be a same-origin relative path (a single leading `/`, no scheme, no `//` — e.g. `/admin/plugin/<slug>`) or the item is dropped with a warning; capped at 50 items per plugin. |
| `wordjs.cron.schedule(ts, recurrence, hook, args)` | — | Host fires the hook back into the child process — only **your** callbacks, never core's. `recurrence` is a registered schedule name (`'hourly'`, `'twicedaily'`, `'daily'`, `'weekly'`, `'off'`); pass `false` for a one-off event at `ts`. An unregistered name is stored with a 0 interval, so it never repeats. |
| `wordjs.crypto.randomToken(bytes=16)` / `randomInt(min, max)` | — | CSPRNG (no data access, no permission gate). Use instead of `Math.random` for tokens/access codes. **Async** in an isolated plugin (RPC to host) — `await` it. |
| `wordjs.assets.enqueueScript(spec)` / `enqueueStyle(spec)` | `assets:write` | Load a `<script>`/`<style>` onto public pages. `spec = { handle, src, inFooter?, strategy?:'async'\|'defer', media? }`. A script that loads code from a third-party host (an analytics provider) names it in `origins` — up to four bare `https://host[:port]` origins: the public pages' Content-Security-Policy allows exactly the origins the active plugins declare, and no other host. Re-enqueue (same `handle`) when they change. **`src` must be a relative path inside your plugin's `public/` directory** with a servable extension — see §11a; anything else throws. The host verifies the file exists + can't escape and emits a **sanitized** tag served from `/plugins/<slug>/public/…` — you never control raw markup (the raw-HTML head/footer hooks stay denied). |

---

## 11a. What of your plugin is served over HTTP ⚠️ *contract change*

**This changed. Read it before shipping an asset.** WordJS no longer publishes your plugin folder as a
static tree. `/plugins/<folder>/…` (addressed by your plugin's **folder** — the admin-page slug is not
an alias here) now serves an **allowlist**, and **only while your plugin is active**:

*   `public/**` with a servable extension — `.css`, `.js`, `.mjs`, images (`.png .jpg .jpeg .gif .webp
    .avif .ico`), fonts (`.woff .woff2 .ttf .otf`), media (`.mp4 .webm .mp3 .ogg .wav`) and `.pdf` —
    served while the plugin is **active**;
*   plus one fixed path, `dist/component.bundle.css` (the stylesheet the host links next to your Verso
    block bundle) — served while the plugin is **active and granted `browser:script`**, the same rule as
    the bundle itself (§12).

**Everything else is a `404`** — your `index.js`, `lib/`, `data/`, `node_modules/`, `.map` files, every
`.json` **including `manifest.json`**, `client/admin/admin.css`, and anything your code writes at
runtime. An inactive plugin's files are the same `404` as a plugin that was never installed. Deliberately
**not** servable: `.html`, `.svg`, `.xml` (they execute as documents in the site's origin) and
`.json`/`.txt`/`.db` (source and data leaks).

**Your admin page's styling** — the manifest's `style` / `theme` fields and `client/admin/admin.css` —
still reaches your page, but not from the static mount: the host's generated admin page reads them through
`GET /api/v1/plugins/<slug>/admin-style` and links `GET /api/v1/plugins/<slug>/admin-style/css`, which
answer a **signed-in** user for an **active** plugin only — and the stylesheet only while the plugin is
granted `browser:script`, the same gate as your `dist/` bundles (a plugin with an admin page declares it
anyway). The host **confines** the sheet before serving it: `@import` and any declaration that would load a
resource (`url()` other than `data:`, `image-set()`, `image()`, `src()`) are dropped — ship images and
fonts as `data:` URLs or reference files from your `public/` folder in markup instead — and every rule is
wrapped in `@scope (:root) to ([data-wjs-host-ui])`, so it styles your page and anything you portal to
`<body>`, but not the admin's own sidebar, header, confirmation dialogs or toasts. A selector that starts at
`:root` or `html` keeps working (it is re-anchored on `:scope`, the same element). Otherwise nothing
changes for you: keep shipping `client/admin/admin.css` and the manifest fields. (The manifest used to be public at
`/plugins/<slug>/manifest.json` — your exact version, author and permissions, to anyone.)

**And every published subtree is read-only to your plugin — `public/` and `dist/` alike.**
`wordjs.fs.write` and a raw `fs` write both refuse any path under either (and `manifest.json` and
`client/admin/admin.css`, which the host reads on your behalf), and `.html` cannot be created anywhere at
all.

**Why, plainly.** Your plugin's `data/` folder is writable **without any grant** — that is deliberate, it
is your scratch space (the code folder around it is read-only). Previously the *entire* directory was also readable over HTTP by anyone, so those
two facts combined into an exfiltration channel that annulled the whole containment model: write
`leak.txt`, then `GET https://site/plugins/<slug>/leak.txt` unauthenticated. The `network` permission,
the egress guard and each platform's native network policy all police the *socket* —
none of them can see a read channel the server itself publishes. It leaked with no malicious plugin
either: mail-server's `data/` (attachments, Bayes corpus) was reachable on a clean install. Making
`public/` unwritable is what stops the same channel reopening one directory over.

**What you must do:** ship browser assets under `public/` as committed build output, and enqueue them
with `wordjs.assets.enqueueScript`/`enqueueStyle`, whose `src` is now validated against exactly this
surface. (The §4 builder's `dist/` output still reaches the browser: the admin, Verso and portal **JS**
bundles are fetched through the API route `/api/v1/plugins/<slug>/bundle`, not statically (a portal's
stylesheet through `/bundle/css?type=portal`, §10.6), and
`dist/component.bundle.css` is the one fixed allowlisted path — both only while the plugin is active and
granted `browser:script`. The same applies to JavaScript under `public/` (`.js`, `.mjs`, `.cjs`): it runs in
the browser on the site's origin, so `/plugins/<slug>/public/*.js` is served only while the plugin is active
**and** granted `browser:script` — declare it next to `assets:write` if you enqueue a script. Styles, images
and fonts under `public/` only need the plugin to be active. It is the *builder* that writes
`dist/`, from outside the sandbox — your plugin's own code cannot.) If you were generating an asset at runtime, move
that data into your own `wjp_<slug>_` table or the options API and render it through a route
(`wordjs.http.route`) instead. Every shipped marketplace plugin already enqueues from `public/`.

---

## 12. Per-plugin capability grants (Android-style)

There is **one** plugin model and **no trust tier**: every plugin is sandboxed, and each capability is
**admin-granted per plugin** with **default-deny**. Your `manifest.json` only *requests* a capability;
an admin *grants* each one in the **Plugins** admin page (`/admin/plugins`,
`POST /plugins/:slug/permissions`, persisted in the `plugin_grants` option). A bridge call works only if
the capability is BOTH declared in the manifest AND granted.

**Grantable capabilities** (the canonical manifest vocabulary is `KNOWN_PERMISSIONS` in
`backend/src/core/plugins.ts`): `database` (read/write — own tables only), `settings` (read/write —
non-secret options), `filesystem` (read/write — own dir), `users:read` (the safe user projection, with the
account's capabilities in your own namespace — §12a), `posts:read` (the post hooks, drafts and private
posts included), `comments:read` (the comment hooks, without the commenter's personal data) /
`comments:pii` (also the commenter's email, IP and user agent — never implied), `notifications:read`
(the `notification_sent` hook, secrets redacted),
`assets:write` (enqueue own scripts/styles on public pages), `email:admin` (send through the active mail
provider) / `email:provider` (*become* the provider), `notifications:send` / `notifications:provider`,
`media:private_read` (describe a private media item and have the host stream it from one of your
routes), `smtp:inbound` (the host listens on the SMTP port for you — exclusive, one plugin at a time),
`ai:use` (text completions through the site's AI provider — the key never reaches the plugin),
`content_access:provider` (answer the members-only content filters — which access levels an account holds
and which the editor offers; never implied, see [memberships.md](memberships.md)),
`express:register_route`, `admin_menu:register`, `browser:script` (serve and run the plugin's compiled
frontend bundles in the browser — **not sandboxed**, see `security.md` §1.3b), `roles:declare` (register the user roles of
the manifest's `roles` block — §12a), and **`network`** (outbound access to **public IPs only**
— the egress guard blocks loopback/link-local/`169.254.169.254` metadata/RFC1918/CGNAT/ULA and validates
the resolved IP at connect time; opt-in, with an exfiltration warning — declare `scope: "network"`).
An admin may narrow a `network` plugin further with a per-plugin **egress host allowlist**
(`GET`/`POST /api/v1/plugins/:slug/egress-hosts`, stored in the `plugin_egress_hosts` option): empty =
allow-all-public, a non-empty list flips that plugin to default-deny for everything but the listed hosts
and their subdomains. The list also governs the plugin's own `dns.lookup` / `dns.lookupService` (a lookup
is egress too), and under a list a host is only matched when it is a plain ASCII hostname (letters,
digits, `-`, `_`, dots) or an IP literal: pass the punycode form of an internationalised name (`fetch` and
`URL` already do). If the host cannot load the egress policy, a `network` plugin reaches no public host
and resolves no name until it reloads.
The one exception to public-only is an **approved private destination**: an administrator may approve
exactly one host on exactly one port for a plugin (`GET`/`POST /api/v1/plugins/:slug/private-egress`, body
`{ destinations: ["192.168.1.20:587"] }`, at most 4) — for example a LAN SMTP relay. It is matched on the
host and the port together (a hostname entry also covers the addresses the guard itself resolved for that
name, so approving a name trusts its DNS), it never opens a range or another port, link-local (`169.254.169.254`), unspecified and multicast
addresses cannot be approved, and an API token may withdraw an approval but never make one.

> **`access: "admin"`** on a scope (a grant token such as `database:admin`) implies only that scope's
> ordinary `read`+`write` verbs — it never subsumes the special verbs (`provider`, `register`,
> `register_route`, `pii`, `private_read`, `inbound`, `use`, `script`, `declare`), which must be granted
> explicitly. It is not part of the manifest vocabulary either: `validateManifestPermissions` rejects
> `access: "admin"` at upload (marketplace installs included) and in the marketplace submission gate
> (`backend/scripts/scan-plugin.mjs`) for every scope except `email`, where `admin` is the ordinary send
> verb. Only a plugin copied onto the disk by hand can carry it. Declare `read` and `write` instead.
> `express:register_route` and `admin_menu:register` are enforced grants, not just manifest vocabulary:
> the host's `register-route` IPC handler (`backend/src/core/plugin-isolate.ts`) checks
> `express:register_route` first and, if it is not granted, logs
> `denied route registration: express:register_route not granted` and mounts nothing — the route-count
> cap, HTTP-verb allowlist and path validation only run after that check. Likewise
> `wordjs.adminMenu.add` runs `verifyPermission('admin_menu', 'register')` before `registerAdminMenu`, so
> an ungranted plugin adds no sidebar item. Both are checked on every (re)spawn, so revoking a grant
> takes effect at the hot-reload that follows a grant change. The caps and allowlists in
> `plugin-isolate.ts` / `adminMenu.ts` apply on top of the grant, never instead of it.

There is no first-party pre-seeding: **activation** grants a plugin exactly the capabilities its
manifest declares (idempotent — only when the plugin holds no grants an administrator decided, so a
revoke survives a re-activation). That grant **is the administrator's consent**: the Plugins screen shows
the activation dialog listing every requested capability (high-risk ones marked, see below) before it
activates, and the seed is recorded as the administrator's decision. **An API token never consents**: a
token-driven activation that would grant capabilities is refused before anything runs, naming them, while
a plugin that requests nothing, or already holds what an administrator decided (re-activating it after a
deactivation or an update), can still be activated headlessly. This applies
identically to first-party plugins (`mail-server`, `conference-manager`, the galleries, …) and
anything you upload. First-party plugins are **not privileged** — they run in the same sandbox under
the same checks.

Changing a plugin's grants **hot-reloads its child process** so the bridge gates re-evaluate and a
`network` change takes effect — no server restart. Granting a higher-risk capability is a real security
decision, and the UI says so: `frontend/src/lib/permissionMeta.ts` classifies `database:write`,
`settings:write`, `filesystem:write`, `comments:pii`, `email:admin`, `email:provider`, `smtp:inbound`,
`notifications:provider`, `media:private_read`, `assets:write`, `browser:script` and `network` as
**high risk**, and both grant screens (the activation dialog and the per-permission
toggles) render those rows with a high-risk badge, a platform-authored explanation, and — separately
labelled — the plugin's own stated reason from its manifest. The platform's label and explanation of each
token, the risk badges and those labels are in the admin's language (`permMeta(token, t)` reads
`perm.<token>.label` / `perm.<token>.description` from `frontend/src/lib/i18n.ts`, es/en/pt; the English in
`permissionMeta.ts` is the fallback). `network` carries the explicit wording
that data can leave your server, and `assets:write` spells out that the plugin's script runs in every
visitor's browser. Only grant capabilities to code you have audited.

> **Removed for good:** there is no shell/`child_process`, native addons, unscoped/core-table DB,
> secret-named options, absolute routes, raw cookie/header control, raw-HTML hooks, or "trusted" tier —
> no plugin can obtain any of these by any grant.

---

## 12a. Declaring user roles (`roles:declare`) 👥

A plugin may ship **user roles of its own** — for example a "conference team" role whose holders can open
the plugin's admin page and nothing else. The administrator creates (or edits) a user, picks the role in
the user form, and that person signs in straight onto the plugin's screen.

**The rule: a role a plugin declares can only ever affect that plugin — never the core, never another
plugin.** It is enforced by a namespace derived from the plugin id, not by trusting the manifest.

```json
"permissions": [
    { "scope": "roles", "access": "declare", "reason": "Declares the conference team role." }
],
"roles": [
    {
        "slug": "conference_manager_team",
        "name": "Equipo de conferencia",
        "description": "Can open the Conference Manager page and nothing else.",
        "capabilities": ["conference_manager_access"]
    }
]
```

*   **Namespace.** `PREFIX` = the plugin id with every character outside `[a-z0-9]` replaced by `_`, plus
    `_` (`conference-manager` → `conference_manager_`). Every role `slug` and every capability **must**
    start with it. `read` and `access_admin_panel` are added by the core to every plugin role (enough to
    enter the admin and reach the user's own account page); do not list them. Up to 10 roles, 50
    capabilities each; the only keys are `slug`, `name`, `description`, `capabilities`.
*   **The core's vocabulary is never yours.** A capability that begins with a core capability verb
    (`access`, `activate`, `create`, `delete`, `edit`, `install`, `list`, `manage`, `moderate`,
    `promote`, `publish`, `read`, `remove`, `switch`, `unfiltered`, `update`, `upload`, each followed by
    `_`) is in no plugin's namespace, whatever the plugin is called: plugin `manage` has the prefix
    `manage_` but can never declare `manage_options`, and plugin `edit-flow` can never declare
    `edit_flow_items` (the capability of a content type called `flow_item`). A plugin whose id begins with
    one of those verbs therefore cannot declare roles; `manager` or `editorial` can.
*   **All or nothing.** One bad entry rejects the whole block, with the reason: at upload, in the
    marketplace submission gate (`backend/scripts/scan-plugin.mjs`) and at activation — and an activation
    that is refused does not half-apply: every check runs before the plugin's code is spawned, so its
    `init()` never runs and no role is written.
*   **Content types are the core's.** A capability that gates a registered content type (its
    `permissions.operations`, which an administrator names freely — `events_publish`) is never a plugin
    role's, even when it carries the plugin's prefix: it is refused at registration and confers nothing if
    a type that uses it is created later.
*   **No shadowing.** A declared slug that is already a core role, a role an administrator created or
    another plugin's role is refused. So is a slug or a capability inside another installed plugin's
    namespace (`foo` may not declare `foo_bar_team` or `foo_bar_x` while `foo-bar` is installed; a role
    registered before `foo-bar` arrived loses that capability — or, for its slug, is orphaned — when any
    plugin is activated), and two installed plugins whose ids map to the same prefix (`a-b`, `a_b`) own
    nothing in it: neither can declare roles, and a role either registered earlier confers nothing of it.
*   **Grant, then registration.** The manifest *requests* `roles:declare`; the administrator *grants* it
    (activation dialog or the per-plugin permission switches, which list the roles the plugin will
    register). The roles are registered when the plugin is activated with the grant, when the grant is
    given to a running plugin, and refreshed from the manifest on disk at every boot. Without the grant
    a role is **inert**: it confers only `read`/`access_admin_panel`.
*   **Afterwards.** The roles live in `wordjs_user_roles` with their provenance
    (`{ source: "plugin", plugin: "<id>" }`); the Roles screen shows them as the plugin's, read-only. The
    administrator may change a plugin role's capabilities only inside the plugin's namespace
    (`POST /roles` → `400 rest_role_plugin_capability` otherwise) and may not rename or delete it while the
    plugin is installed (`409 rest_role_plugin_managed`). Such an edit is kept as the role's
    `adminChanges` (`{ added, removed }`), so the next activation, boot or permission change re-applies the
    manifest's definition **with the administrator's edit on top** — a capability taken away to close
    the plugin's screens to a role stays away. The boot-time role sync cuts anything that does not
    belong, and the capabilities a user actually holds are computed from the namespace at every check, so
    even a hand-edited option cannot give a plugin role a core capability. Role writes run one at a time
    (a plugin role's refresh cannot overwrite an administrator's concurrent edit of another role), in each
    process and across nodes, and each one is computed on the roles map stored in the database and saved
    only while it is still that map — a role change made on another node is never written back over — and on
    several nodes a `roles:declare` grant or revoke reaches every node through the same Redis signal as a
    role edit.
*   **Lifecycle.** Deactivating the plugin keeps its roles (their holders keep their accounts; the
    capabilities reach nothing while the plugin is off). **Deleting** it removes each role nobody holds and
    keeps the others **orphaned** — their holders keep only `read`/`access_admin_panel`; the administrator
    can delete the role once nobody holds it (`409 rest_role_in_use` with `data.holders` while someone
    does — a dangling role would be handed back to its holders by the next plugin declaring that slug). A
    role whose plugin folder disappeared without the delete (removed by hand, a restored backup) is
    orphaned at boot. A new version that stops declaring a role retires it the same way. Installing the
    same plugin again re-adopts an orphaned role: its holders get its permissions back once
    `roles:declare` is granted, so the grant screens show, next to each declared role, how many users
    already hold it (`GET /plugins` → `roles[].holders`). While the grant is not in effect the note says
    those users get the role's permissions back when it is granted; while it is, it only counts them
    (they already have those permissions). Activating a plugin grants its requested permissions only when
    it has no grant on record (`POST /plugins/:slug/activate`), so a permission revoked earlier stays
    revoked: the activation dialog marks such a permission "Stays off" (`grantState.ts activationGrant`),
    and under `roles:declare` its note says activating does not give the holders their permissions back —
    granting it in Permissions does.

**Gating your routes and your page.** A route registered with `{ auth: true }` receives
`req.user.pluginCapabilities`: the caller's capabilities **in your namespace** (from your own roles or
from a core/custom role an administrator gave them) — never a core capability, never another plugin's.
An administrator receives every capability your roles confer, so `req.user.pluginCapabilities.includes(
'conference_manager_access')` is a complete check (`req.user.role === 'administrator'` still works). The
users bridge (`users:read`) adds the same `pluginCapabilities` to every account it returns, so you can
tell which accounts your screens are open to. Prefer the capability over the role slug: an administrator
may give your capability to another role (an editor who also works in your plugin) — the
conference-manager team accepts any account whose role holds `conference_manager_access`. Register your
admin menu item with your capability (`cap: 'conference_manager_access'`) so the item — and through it
your page (§10.1) — is offered exactly to the users who hold it.

## 12b. Declaring per-account capabilities (`accountCapabilities`) 🎫

A role says what a whole class of accounts may do. Some features are instead a per-**account** decision
an administrator makes on the user screen, whatever the account's role: "this editor gets a mailbox",
"this author may sell tickets". Declare such a capability in your manifest and the core does the rest —
without knowing what it means:

```json
"accountCapabilities": [
    {
        "slug": "my_plugin_seller",
        "name": "Ticket seller",
        "description": "Can create and sell tickets from this site.",
        "locksEmail": false,
        "defaultForNewAccounts": false
    }
]
```

* **Namespace.** `slug` follows the role rules of §12a: it starts with your prefix (`my_plugin_` for
  `my-plugin`), is not a core capability name, and is not inside another installed plugin's namespace.
  Upload and activation refuse an invalid block; a hand-edited one is ignored (read time re-checks it).
  At most 10 entries; keys other than the five above are refused.
* **The grant.** Users → edit user shows one toggle per capability of every **active** plugin, to callers
  holding `edit_users` only (`GET /api/v1/users/account-capabilities`). `POST /users` and `PUT /users/:id`
  take `accountCapabilities: { "<slug>": true|false }`; changing one needs `edit_users` whoever the target
  is, a resend of the current state is a no-op, and a change naming a capability no active plugin declares
  is refused (`400`). `PUT /users/me` ignores the field, the generic `meta` bag cannot reach the stored
  keys (`user_meta account_capability:<slug>`), and **no role implies a grant — not even administrator**.
  Nothing is ever derived from the account's email address. An API token cannot change a grant.
* **What you are told.** `req.user.accountCapabilities` on an `auth` route and `accountCapabilities` on every
  `wordjs.users.*` result: the account's grants **among your own declared capabilities** — never another
  plugin's. Gate on it: `req.user.accountCapabilities.includes('my_plugin_seller')`. Rebuilt per request, so
  a revocation denies the very next one.
* **`requiresAccountCapability`** on an admin menu item (`wordjs.adminMenu.add`) hides the item from every
  non-administrator without the grant — the same grant your route gate reads, so the menu never offers a
  page that only 403s. A capability outside your namespace hides the item from all non-administrators.
* **`locksEmail: true`** — while an account holds the capability, it cannot change its own primary
  address (`403 rest_mailbox_address_locked`); an `edit_users` administrator still can. Use it when your
  service lives at that address. It keeps applying while your plugin is deactivated.
* **`defaultForNewAccounts: true`** — the toggle starts on in the "new user" form (an explicit,
  visible choice the administrator can turn off before saving).

Declaring capabilities needs no permission: by itself a declaration confers nothing, and its two effects
on the core (`locksEmail`, `requiresAccountCapability`) only ever restrict. Deactivating your plugin keeps
the stored grants (they reappear when it is reactivated); its toggles disappear from the user screen.
The mail-server plugin's "Professional mail account" is declared this way ([mail-server.md](./mail-server.md)).

## 13. Verso Blocks (Visual Editor Components) 🧩

Plugins can add blocks to the visual page builder (**Verso**). This is how it actually works, end to end.

> **Renamed, not broken.** The editor used to be a fork of Puck and the API carried its name. Every
> historical spelling below still works and will keep working — a plugin you published before the
> rename keeps loading with nobody touching it. The build just prints a deprecation line.
>
> | | current | still accepted (deprecated) |
> |---|---|---|
> | manifest key | `frontend.versoComponents` | `frontend.puckComponents` |
> | folder convention | `client/verso/<Pascal>Verso.tsx` | `client/puck/<Pascal>Puck.tsx` |
> | single-block export | `versoComponentDef` | `puckComponentDef` |
> | multi-block export | `versoComponents` | `puckComponents` |
>
> When both spellings are present the **new one wins**. All four are resolved by one shared module,
> `backend/scripts/plugin-block-contract.js`, which the registry generator, `build-plugin.js`,
> `build-marketplace.js` and `verify-marketplace.js` all `require` — so the tool that imports your block
> and the tool that packages it can never disagree about where it lives.
>
> Your render component also still receives the legacy **`puck` prop** —
> `{ isEditing, metadata, dragRef, renderDropZone }` — with `renderDropZone({ zone })` mapped onto the
> engine's slots (`frontend/src/lib/verso/pluginBlocks.tsx`). A third-party bundle compiled against the
> old contract keeps working without a recompile.
>
> **Setup hints are for the editor.** In the editor a block also receives `isEditing: true`; on a public
> page it is absent. Read `isEditing || puck?.isEditing`: a block that is not configured yet (no form, poll
> or gallery chosen, nothing to list) shows its hint — "choose a form in the block panel" — only in the
> editor, and renders nothing for visitors, who must never read admin instructions. The first-party blocks
> (contact-forms, polls, card-gallery, photo-carousel, video-gallery, youtube-videos, digital-downloads,
> event-tickets, social-share, memberships, table-of-contents) all follow this.
>
> The one name that is *not* changing is the post-meta key `_puck_data`, where a page's document is
> stored. It is not a name in our source — it is a **value already written into the `postmeta` table of
> every installation in the wild**, and into every WXR export ever taken from one. Renaming it would
> mean a data migration whose failure mode is losing the body of every block-built page, in exchange for
> cosmetics. So it is frozen, deliberately: read it as "the editor's document blob", not as a reference
> to the retired engine. The decision is recorded next to the constants themselves —
> `CONTENT_META_KEY` (`frontend/src/lib/verso/types.ts`, the load side) and `EDITOR_DATA_META_KEY`
> (`frontend/src/lib/editorGuards.ts`, the save side).

### 13.1 Declare the entry in `manifest.json`

`frontend.versoComponents` is an **object** with a single `entry` (**not** an array):

```json
"frontend": {
    "versoComponents": { "entry": "client/verso/MyPluginVerso.tsx" }
}
```

If you omit it, a convention fallback is tried: `client/verso/<Pascal>Verso.tsx`, where `<Pascal>` is the PascalCase of the plugin folder (e.g. `card-gallery` → `CardGalleryVerso.tsx`). The legacy `client/puck/<Pascal>Puck.tsx` is tried after it.

### 13.2 The export contract

`frontend/scripts/generate-verso-plugin-registry.js` reads your entry file and supports exactly two shapes:

**One block** — `export const versoComponentDef` (label/category/fields/defaultProps) **plus** a default-exported render component. The block is registered under the PascalCase of your manifest `id` (`card-gallery` → `CardGallery`):

```tsx
// @ts-nocheck
"use client";

export const versoComponentDef = {
    label: "Card gallery",
    category: "My Plugin",
    fields: {
        title: { type: "text" as const, label: "Title" }
    },
    defaultProps: { title: "Hello" }
};

export default function MyPluginVerso({ title = "" }) {
    return <section>{title}</section>;
}
```

**Multiple blocks** — a single `export const versoComponents = { ... }` where each value already includes its `render`. Detection is literal: the generator matches `export const versoComponents` (or the deprecated `export const puckComponents`) in the file text and spreads the object into the registry:

```tsx
export const versoComponents = {
    PriceTable: { ...priceTableDef, label: "Price table", render: PriceTable },
    FaqList:    { ...faqListDef,   label: "FAQ list",    render: FaqList },
};
```

**Block name (`label`, optional)** — the name the editor shows in the block palette, the outline and the properties panel. Without it, the editor splits the block id into words (`ReadingList` → "Reading List", `FAQSection` → "FAQ Section"); set `label` when that is not the name you want users to see. It is shown as written — the editor does not translate plugin labels.

> Export **only** the shape you use. The generated registry does `import * as X` and statically references either `X.versoComponents` **or** `X.versoComponentDef` + `X.default` — referencing a member that isn't a real export is a hard build error under Turbopack. The generator reads which name your file actually declares, so a bundle exporting the deprecated names is referenced by *those* names.

### 13.3 The activate → regenerate → restart flow

The registry (`frontend/src/lib/versoPluginRegistry.ts`) is **generated, not dynamic**, and includes **active plugins only**:

1. Activate the plugin in `/admin/plugins`.
2. **Development:** nothing to run. On every activation, deactivation and deletion a backend that is not
   running with `NODE_ENV=production` re-runs all four generators (`generate-plugin-registry.js`,
   `generate-admin-plugin-registry.js`, `generate-verso-plugin-registry.js`,
   `generate-portal-plugin-registry.js`) with the active list in `WORDJS_ACTIVE_PLUGINS`
   (`regenerateRegistry()` in `backend/src/routes/plugins.ts`, §3.1). Run one by hand —
   `node frontend/scripts/generate-verso-plugin-registry.js` — only after editing a manifest's entry
   points without re-activating; run that way it asks `GET /api/v1/plugins/active` on `localhost:3000`
   and, if the backend isn't reachable, falls back to including **all** plugins that have a block entry.
3. Let Fast Refresh reload the frontend dev server (restart it if it does not pick the change up); a
   self-built production frontend needs a rebuild, while a plugin installed at runtime is loaded from its
   prebuilt `dist/component.bundle.js` (§3.2).

Your block then appears in the editor's component list and renders both in the editor iframe and on the live SSR site. Deactivating a plugin removes its blocks again.

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

> **Scaffold all of this:** `node backend/cli/wordjs.js create plugin my-plugin` generates a working single-block Verso component wired to the manifest — see `documentation/cli.md` §3.

---

## 14. Manifest field reference 📋

Every `manifest.json` key something in WordJS reads, and what reads it (`backend/src/core/plugins.ts`,
`backend/src/routes/plugins.ts`, `backend/src/routes/plugin-bundles.ts`, `backend/src/core/inbound-smtp.ts`,
`backend/scripts/build-plugin.js`, `backend/scripts/pack-plugin.js`, the `frontend/scripts/generate-*-registry.js`
generators and the marketplace scripts). The manifest may be at most 64 KB.

**Identity**

| Key | Required | Meaning |
| :-- | :-- | :-- |
| *(folder name)* | — | The plugin's **slug**: its routes (`/api/v1/plugin/<slug>`), tables (`wjp_<slug>_`), grants, `wordjs.slug`. It is not a manifest key. |
| `id` | no | When present it must equal the folder name (`npm run pack:plugin` and the marketplace gate refuse a mismatch). The registry generators and the Verso block name (PascalCase of `id`) use it, falling back to the folder. |
| `name` | **yes** | Display name; the upload refuses a manifest without it. |
| `version` | no (marketplace: semver) | Shown in the admin list (`1.0.0` when absent); names the packed ZIP (`<slug>-<version>.zip`). |
| `description`, `author` | no (marketplace: yes) | Shown in the admin list and the marketplace catalog. |
| `isolated` | **yes** | Must be `true`; anything else is refused at upload, activation and boot. |

**Capabilities and dependencies**

| Key | Meaning |
| :-- | :-- |
| `permissions` | Array of `{ "scope", "access", "reason" }` (`network` takes no `access`). Checked against `KNOWN_PERMISSIONS` (§12); the activation dialog and permission screens show `reason` next to the platform's own explanation. The marketplace gate also accepts a `permissions_rationale` object keyed by grant token instead of inline reasons. |
| `dependencies` | npm package → registry semver range, installed by the host on activation (§2). |
| `bundled` | `true` = the plugin ships its own `node_modules/`; the host skips shared install/garbage-collection. |
| `roles` | User roles the plugin declares (§12a); requires `roles:declare`. |
| `shortcodes` | `[{ "tag": "…" }]` — the `[tag]` / `[tag key="value"]` embeds a static HTML front page renders with your site component (`frontend.components`), its attributes passed as props. Served to the front end by `GET /api/v1/plugins/shortcodes` for active plugins; a tag is an identifier and the first plugin (by slug) to declare it owns it. Server-side expansion is still your code's `wordjs.shortcodes.add`. |
| `accountCapabilities` | Per-account capabilities an administrator grants on the user screen (§12b). |
| `claimPorts` | Array of port numbers the plugin needs (`[25]` for a mail server). Only these ports are eligible for the admin's port-conflict screen (`/api/v1/plugins/:slug/port-conflicts`), and they are the ports `wordjs.smtp.listen` may ask the host for. |

**Frontend (`frontend.*`)** — any of these needs `browser:script` (§2).

| Key | Meaning |
| :-- | :-- |
| `frontend.adminPage` | `{ "entry", "slug" }` — the admin page at `/admin/plugin/<slug>` (§2 Step 3, §10.1). |
| `frontend.hooks` | Path (a string) of the hooks file whose `register*` exports run on admin load (§2 Step 4). |
| `frontend.portalPage` | `{ "entry", "slug", "title"?, "themeColor"?, "viewportFit"?, "pages"?, "serviceWorker"?, "file"? }` — the public page at `/portal/<slug>` and its sub-pages (§10.6). |
| `frontend.versoComponents` | `{ "entry" }` — the Verso block file (§13); the deprecated `frontend.puckComponents` is still read. `null` or absent → the `client/verso/<Pascal>Verso.tsx` convention. |
| `frontend.components` | Legacy *location* components, `[{ "name", "entry", "locations", "props" }]`; the development registry takes the first `entry`. |
| `style`, `theme` | Admin-page styling, returned by `GET /api/v1/plugins/<slug>/admin-style` (§11a): `style` is a string, `theme` an object whose keys become `--plugin-<key>` variables. |

**Marketplace submission only** — `license` (an accepted OSI SPDX identifier, with a `LICENSE` file) and
`repository` (an `https://` URL) are checked by `backend/scripts/scan-plugin.mjs`
([`marketplace/REVIEW.md`](../marketplace/REVIEW.md) §2); the runtime does not read them.

**Present in shipped manifests, ignored by the runtime:**

| Key | Status |
| :-- | :-- |
| `adminMenu` | Read only by `build-marketplace.js`, for the catalog card's label and icon. The sidebar item comes from `wordjs.adminMenu.add` in your code. |
| `api` | Not read. Routes exist only when your code registers them. |
| `backend.entry`, `main` | Not read. The backend entry is the first of `index.js`, `main.js`, `plugin.js` found in the plugin folder. |
| `active` | Not read. Whether a plugin is active is the core's state, not the manifest's. |
| `themeSurfaces` | Not read at runtime; a frontend CI test (`frontend/src/lib/__tests__/pluginSelectorContract.test.ts`) checks the declarations of the plugins committed to the repository. |

An `exports.metadata` object in the entry file is not read either: the admin list takes name, version,
description and author from the manifest.


