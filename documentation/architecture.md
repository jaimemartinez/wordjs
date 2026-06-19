# WordJS Architecture Overview

This document provides a comprehensive visual overview of the WordJS system architecture.

---

## 🏗️ System Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        Browser[🌐 Browser]
        Mobile[📱 Mobile]
    end

    subgraph "Gateway Layer"
        Gateway[🚀 Gateway :3000]
        note[Features: Load Balancing & Circuit Breaking]
        Gateway -.-> note
    end

    subgraph "Frontend Layer"
        NextJS[⚛️ Next.js Frontend :3001]
        Puck[🎨 Puck Editor]
        Themes[🎭 Theme Engine]
    end

    subgraph "Backend Layer"
        Express[📦 Express API :4000]
        Hooks[🪝 Hook System]
        Cron[⏰ Cron Jobs]
    end

    subgraph "Plugin Layer"
        PluginCore[🔌 Plugin Manager]
        Plugin1[Plugin 1]
        Plugin2[Plugin 2]
        PluginN[Plugin N]
    end

    subgraph "Data Layer"
        SQLite[(🗄️ SQLite)]
        PostgreSQL[(🐘 PostgreSQL)]
        MediaFS[📁 Media Files]
    end

    Browser --> Gateway
    Mobile --> Gateway
    Gateway --> NextJS
    Gateway --> Express
    NextJS --> Puck
    NextJS --> Themes
    Express --> Hooks
    Express --> Cron
    Hooks --> PluginCore
    PluginCore --> Plugin1
    PluginCore --> Plugin2
    PluginCore --> PluginN
    Express --> SQLite
    Express --> PostgreSQL
    Express --> MediaFS
```

---

## 🚦 Run Modes (SPLIT vs MONOLITH)

The **same codebase** runs two ways, and you can switch **at any time** with no migration. Both modes share the same `backend/wordjs-config.json`, the same database, the same `uploads/`, `themes/`, and `plugins/`, the same secrets, and the same public origin (`https://localhost:3000`). They are **mutually exclusive** — both bind the public port (default **3000**) — so only one runs at a time. In **both** modes plugins stay **isolated** in worker threads exactly as described in the Plugin System section.

### SPLIT (default — 3 processes)

The architecture diagrams above describe this mode: three processes behind the gateway.

- **gateway** (`:3000`, public) — Node `cluster` reverse proxy.
- **backend** (`:4000`) — Express REST API + plugins.
- **frontend** (`:3001`) — Next.js.

The gateway provides clustering, health-checks, load-balancing, an **mTLS** internal channel (see *Internal Security*), and SSE-aware proxying. Run with `npm run dev` (dev) or `npm start` (prod).

**Choose SPLIT to** scale the services independently and get the gateway's clustering / health-checks / load-balancing.

### MONOLITH (1 process, 1 port)

A single process on one port (`:3000`) via the repo-root entrypoint **`monolith.js`**. It mounts the **backend Express app** (with its isolated worker-thread plugins) **and** the **Next.js request handler** *in-process* — no loopback proxy, no Node `cluster`, no gateway `/register`. The gateway's still-needed cross-cutting concerns are re-implemented as **local middleware**:

- `helmet`
- `compression` (skipping SSE)
- SEO rewrites — `/sitemap.xml` → `/api/v1/seo/sitemap.xml`, `/robots.txt` → `/api/v1/seo/robots.txt`
- `X-Forwarded-Host` pinning for CSRF

It serves **one HTTPS port**, reusing the gateway's certificate (with HTTP fallback). A **loopback-only HTTP listener** serves the frontend's server-side (SSR) API calls.

Scripts: `npm run dev:mono` (dev — Next dev HMR + `ts-node` backend), `npm run build:mono` (compiles the backend to `dist/` + runs `next build`), `npm run start:mono` (prod — runs the compiled build).

> **Internals:** `monolith.js` sets `WORDJS_EMBEDDED=1` (and `WORDJS_MODE=mono`); when embedded, backend `src/index.ts` skips its own self-listen and gateway self-register and instead exposes `initialize()` for the entrypoint to mount.

**Choose MONOLITH for** the simplest single-artifact deploy — one VM/container, TLS via its built-in HTTPS or a single reverse proxy in front.

### Observability — `/metrics`

The backend exposes a Prometheus endpoint at **`GET /metrics`** (`backend/src/core/metrics.ts`): the default Node/process metrics (CPU, RSS/heap, event-loop lag, GC, handles, prefixed `wordjs_`) plus app-level gauges including **`wordjs_sse_clients`** (active SSE clients on this node).

It is **disabled by default** — without a configured scrape token the route returns **404**, so metrics are never exposed publicly by accident. Enable it by setting a token at `config.metrics.token` (or the `METRICS_TOKEN` env var) and scraping with an `Authorization: Bearer <token>` header. The endpoint is reachable through the public origin in **both** run modes — routed by the gateway in SPLIT mode and included in the backend prefixes in MONOLITH mode.

---

## 🔄 Request Flow

```mermaid
sequenceDiagram
    participant U as User
    participant G as Gateway
    participant F as Frontend
    participant B as Backend
    participant DB as Database

    U->>G: HTTP Request
    G->>G: Route Matching
    
    alt Static Page
        G->>F: Forward to Next.js
        F->>B: API Call (if needed)
        B->>DB: Query
        DB-->>B: Data
        B-->>F: JSON Response
        F-->>G: Rendered HTML
    else API Request
        G->>B: Forward to Backend
        B->>B: Authentication
        B->>B: Run Hooks
        B->>DB: Query/Mutation
        DB-->>B: Result
        B-->>G: JSON Response
    end
    
    G-->>U: HTTP Response
```

### Public-Site SSR Data Flow

The public site is **real server-side rendering**, not the former client-only skeletons: every route under `frontend/src/app/(public)/` — home (`page.tsx`), category/post (`[slug]`, `[slug]/[postSlug]`), standalone pages (`pages/[slug]`), and `search` — is an **async React Server Component** that fetches its content on the server, so the initial HTML (and what crawlers see) already contains the real title/body.

- **Server-only data layer — `frontend/src/lib/server-api.ts`.** Resolves the backend base URL the same way both run modes expect: in MONOLITH it uses the in-process backend's plain-HTTP loopback (`WORDJS_MONO_ORIGIN`, default `http://127.0.0.1:4000`); in SPLIT it reads the backend port from `wordjs-config.json` (default 4000); an `INTERNAL_API_URL` override wins when set. Loaders (`getPostBySlug`, `getPosts`, `getSettings`, …) are wrapped in React `cache()` so `generateMetadata()` and the page body share **one** request-scoped backend call instead of fetching twice.
- **`x-forwarded-host` forwarding (critical).** SSR fetches hit the loopback origin, so `serverFetch` relays the inbound `x-forwarded-host` / `x-forwarded-proto` one more hop to the backend. Without this the backend's host-based logic — the **Site-URL / migration guard, CSRF origin check, and canonical / OpenGraph / sitemap URLs** — would see `localhost:4000` instead of the real public host and (e.g.) reject every SSR request with a `409 migration_required`. The public listener (gateway in SPLIT, the `monolith.js` middleware in MONOLITH) already pins `x-forwarded-host` to the browser's `Host`.
- **Content rendered in client components fed server data as props.** The fetched data is passed into `frontend/src/components/public/PostContent.tsx` and `HomeContent.tsx`, which SSR the content and then hydrate the interactive bits (carousels, comments). `sanitize.ts` is `"use client"`, so `sanitizeHTML` cannot run in a Server Component — sanitized-HTML blocks carry `suppressHydrationWarning` because server `sanitize-html` and client `DOMPurify` serialize styles slightly differently.
- **SEO + 404.** Each page exports `generateMetadata` (title template, description, canonical, OpenGraph / Twitter — built by `buildPostMetadata` / `htmlToText`), and missing content calls `notFound()` for a real HTTP 404. Search is a **no-JS GET form**.

---

## 🎨 Theme System

```mermaid
graph LR
    subgraph "Theme Request Flow"
        Page[📄 Page Load]
        ThemeLoader[🔄 ThemeLoader.tsx]
        API[📡 /api/themes/active]
        CSS[🎨 style.css]
    end

    subgraph "Theme Files"
        ThemeDir[📁 themes/]
        Theme1[default/]
        Theme2[neo-digital/]
        Theme3[soft-glass/]
        ThemeN[...]
    end

    subgraph "CSS Variables"
        Colors[🌈 Colors]
        Typography[📝 Typography]
        Spacing[📏 Spacing]
        Components[🧩 Components]
    end

    Page --> ThemeLoader
    ThemeLoader --> API
    API --> ThemeDir
    ThemeDir --> Theme1
    ThemeDir --> Theme2
    ThemeDir --> Theme3
    ThemeDir --> ThemeN
    Theme1 --> CSS
    CSS --> Colors
    CSS --> Typography
    CSS --> Spacing
    CSS --> Components
```

### Theme CSS Variable Flow

```mermaid
graph TD
    subgraph "core.css"
        CoreVars[Default Variables]
    end

    subgraph "theme/style.css"
        ThemeVars[Theme Overrides]
    end

    subgraph "Components"
        Header[Header]
        Footer[Footer]
        Cards[Cards]
        Buttons[Buttons]
    end

    CoreVars --> ThemeVars
    ThemeVars --> Header
    ThemeVars --> Footer
    ThemeVars --> Cards
    ThemeVars --> Buttons
```

---

## 🎯 Puck Editor Flow

```mermaid
graph TB
    subgraph "Admin Interface"
        Editor[📝 Puck Editor]
        Sidebar[📋 Component Sidebar]
        Canvas[🖼️ Visual Canvas]
        Props[⚙️ Property Panel]
    end

    subgraph "Component Registry"
        Config[puckConfig.tsx]
        Core[Core Components]
        Plugins[Plugin Components]
    end

    subgraph "Component Categories"
        Content[📄 Content]
        Layout[📐 Layout]
        Media[🎬 Media]
        Marketing[📢 Marketing]
        Dynamic[🔄 Dynamic]
    end

    subgraph "Output"
        PuckData[📦 _puck_data JSON]
        Render[⚛️ Puck Render]
        HTML[🌐 Final HTML]
    end

    Editor --> Sidebar
    Editor --> Canvas
    Editor --> Props
    Sidebar --> Config
    Config --> Core
    Config --> Plugins
    Core --> Content
    Core --> Layout
    Core --> Media
    Core --> Marketing
    Core --> Dynamic
    Canvas --> PuckData
    PuckData --> Render
    Render --> HTML
```

### Component Hierarchy

```mermaid
graph TD
    subgraph "Content Components"
        Heading[Heading]
        Text[Text]
        Image[Image]
        Button[Button]
        Card[Card]
        Divider[Divider]
        Spacer[Spacer]
    end

    subgraph "Layout Components"
        Columns[Columns]
        Section[Section]
        Grid[Grid]
        FlexRow[FlexRow]
    end

    subgraph "Interactive Components"
        Accordion[Accordion]
        Tabs[Tabs]
    end

    subgraph "Media Components"
        VideoEmbed[VideoEmbed]
        AudioPlayer[AudioPlayer]
    end

    subgraph "Marketing Components"
        PricingTable[PricingTable]
        Testimonial[Testimonial]
        CTABanner[CTABanner]
    end

    subgraph "Dynamic Components"
        PostsGrid[PostsGrid]
        CategoryPosts[CategoryPosts]
        SearchBar[SearchBar]
    end
```

---

## 🔌 Plugin System

```mermaid
graph TB
    subgraph "Plugin Lifecycle"
        Install[📥 Install]
        Scan[🔍 Security Scan]
        Register[📋 Register]
        Activate[✅ Activate]
        Execute[⚡ Execute]
    end

    subgraph "Plugin Structure"
        MainJS[main.js]
        Routes[routes/]
        Client[client/]
        PuckComp[puck/]
    end

    subgraph "Hook System"
        Actions[Actions]
        Filters[Filters]
    end

    subgraph "Integration Points"
        API[REST API]
        Frontend[Frontend Components]
        Menu[Admin Menu]
        Cron[Cron Jobs]
    end

    Install --> Scan
    Scan --> Register
    Register --> Activate
    Activate --> Execute
    Execute --> MainJS
    MainJS --> Routes
    MainJS --> Client
    Client --> PuckComp
    MainJS --> Actions
    MainJS --> Filters
    Routes --> API
    PuckComp --> Frontend
    MainJS --> Menu
    MainJS --> Cron
```

### Isolated-only sandbox

Plugin server code does **not** run in the host process. Every plugin executes in a `worker_threads` isolate and reaches the host only through the permission-checked `wordjs` capability bridge (`src/core/plugin-worker.js`). An acorn AST static scanner (fail-closed) runs at install. There are **two server-side trust tiers** (`src/core/plugin-trust.ts`), never self-declarable:

- **untrusted** (default, sandboxed): own DB tables, non-secret options, namespaced routes, **no outbound network** (`fetch`/`WebSocket`/`EventSource` trapped, raw net modules blocked).
- **operator-trusted** (privileged): unscoped DB, secret options, absolute routes, mail provider, raw sockets.

Trust comes from `config.trustedSystemPlugins` (shipped defaults) or an admin toggle in the Plugins UI (persisted in the `trusted_plugins` option). Toggling trust **hot-reloads** the worker; unload/reload does a full teardown. The former `db-migration` plugin has moved into core at `src/core/db-admin/`.

---

## 🔐 Authentication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant G as Gateway
    participant B as Backend
    participant DB as Database

    U->>F: Login Request
    F->>G: POST /api/auth/login
    G->>B: Forward Request
    B->>DB: Validate Credentials
    DB-->>B: User Data
    B->>B: Generate JWT
    B-->>G: JWT Token
    G-->>F: Set Cookie
    F-->>U: Redirect to Dashboard

    Note over U,DB: Subsequent Requests

    U->>F: Protected Request
    F->>G: Request + JWT Cookie
    G->>G: Validate JWT
    G->>B: Forward with User Context
    B->>B: Check Capabilities
    B-->>G: Response
    G-->>F: Response
    F-->>U: Render Page
```

---

## 📊 Data Flow

```mermaid
graph LR
    subgraph "Content Management"
        Posts[📝 Posts]
        Pages[📄 Pages]
        Media[🖼️ Media]
        Categories[📂 Categories]
    end

    subgraph "Configuration"
        Settings[⚙️ Settings]
        Menus[📋 Menus]
        Widgets[🧩 Widgets]
        Themes[🎨 Themes]
    end

    subgraph "User Management"
        Users[👥 Users]
        Roles[🔐 Roles]
        Capabilities[✅ Capabilities]
    end

    subgraph "Database Tables"
        posts_table[(posts)]
        options_table[(options)]
        users_table[(users)]
        meta_table[(meta)]
    end

    Posts --> posts_table
    Pages --> posts_table
    Media --> posts_table
    Categories --> meta_table
    Settings --> options_table
    Menus --> options_table
    Widgets --> options_table
    Themes --> options_table
    Users --> users_table
    Roles --> options_table
    Capabilities --> options_table
```

### WordPress Importer (WXR)

WordJS can migrate an existing WordPress site from its **WXR** (WordPress eXtended RSS) export. The core lives in `backend/src/core/wxr-import.ts` (`parseWxr` / `analyzeWxr` / `importWxr`), exposed through `backend/src/routes/import.ts` and the **Import** admin screen at `/admin/import` (sidebar entry). Both endpoints are **admin-only** and take the `.xml` export as the multipart `file` field:

- `POST /api/v1/import/wordpress/analyze` — dry-run that returns entity counts without writing anything.
- `POST /api/v1/import/wordpress` — runs the import (form options: `defaultAuthorId`, `importComments`, `importAttachments`).

It maps WordPress onto WordJS models — `wp:author` → users (random password, must be reset; matched by login/email), categories → `category` terms (parent hierarchy preserved), tags → `post_tag` terms, and `item`s → posts/pages with post meta, term relationships, and threaded comments (spam/pingbacks skipped). The import is **idempotent / re-runnable** (existing users, terms, and posts are matched, not duplicated), preserves original publish dates, and applies light `wpautop` to classic content. **Attachments are skipped** (the WXR carries only media URLs, not the binaries) along with `nav_menu_item` entries.

---

## 🖥️ Frontend Component Tree

```mermaid
graph TD
    subgraph "App Layout"
        RootLayout[RootLayout]
        PublicLayout[Public Layout]
        AdminLayout[Admin Layout]
    end

    subgraph "Public Pages"
        HomePage[Home Page]
        PostPage[Post Page]
        SearchPage[Search Page]
    end

    subgraph "Admin Pages"
        Dashboard[Dashboard]
        PostsAdmin[Posts Manager]
        PagesAdmin[Pages Manager]
        ThemesAdmin[Themes Manager]
        PluginsAdmin[Plugins Manager]
        SettingsAdmin[Settings]
    end

    subgraph "Shared Components"
        Header[Header]
        Footer[Footer]
        Sidebar[Sidebar]
        ThemeLoader[ThemeLoader]
    end

    RootLayout --> PublicLayout
    RootLayout --> AdminLayout
    PublicLayout --> HomePage
    PublicLayout --> PostPage
    PublicLayout --> SearchPage
    AdminLayout --> Dashboard
    AdminLayout --> PostsAdmin
    AdminLayout --> PagesAdmin
    AdminLayout --> ThemesAdmin
    AdminLayout --> PluginsAdmin
    AdminLayout --> SettingsAdmin
    PublicLayout --> Header
    PublicLayout --> Footer
    PublicLayout --> ThemeLoader
    AdminLayout --> Sidebar
```

---

## 📁 File Structure Overview

```
wordjs/
├── 📁 frontend/              # Next.js Frontend
│   ├── 📁 src/
│   │   ├── 📁 app/             # App Router Pages
│   │   │   ├── 📁 (public)/    # Public Site
│   │   │   ├── 📁 admin/       # Admin Dashboard
│   │   │   └── 📁 api/         # API Routes
│   │   ├── 📁 components/      # React Components
│   │   │   ├── puckConfig.tsx  # Puck Component Registry
│   │   │   ├── Header.tsx      # Site Header
│   │   │   └── Footer.tsx      # Site Footer
│   │   └── 📁 lib/             # Utilities
│   └── package.json
│
├── 📁 backend/                  # Express.js Backend (TypeScript, compiled for prod)
│   ├── 📁 src/                 # All .ts; `npm run build` emits dist/
│   │   ├── 📁 core/            # Core Modules (incl. db-admin/, plugin-worker.js)
│   │   ├── 📁 drivers/         # DB driver interface + implementations
│   │   ├── 📁 routes/          # API Routes
│   │   └── 📁 plugins/         # Plugin System (plugin code stays .js)
│   ├── dist/                   # Compiled output (npm run build) — prod entry
│   ├── tsconfig.json           # strict typecheck config (commonjs)
│   ├── tsconfig.build.json     # production build config (emits dist/)
│   ├── 📁 themes/              # Theme Files
│   │   ├── 📁 default/
│   │   ├── 📁 neo-digital/
│   │   ├── 📁 soft-glass/
│   │   └── 📁 .../
│   ├── 📁 public/              # Static Assets
│   │   └── 📁 css/
│   │       └── core.css        # Core Styles
│   └── package.json
│
├── 📁 documentation/            # Documentation
│   ├── api.md
│   ├── frontend.md
│   ├── themes.md
│   ├── plugins.md
│   └── architecture.md         # This file
│
├── 📁 gateway/                  # Cluster Gateway (reverse proxy + mTLS)
│   ├── 📁 src/
│   │   ├── index.js            # Gateway entry (Node cluster)
│   │   └── proxy-config.js     # Proxy + mTLS upstream agent
│   ├── gateway-config.json      # Gateway config (secret, ports, ssl, mtls)
│   └── gateway-registry.json    # Persisted service registry + health
│
├── 📁 setup/                    # Setup/migration orchestrator + mTLS cert gen
│   └── index.js
├── package.json                 # Root Package (concurrently dev/prod runner)
└── README.md                    # Project README
```

---

## 🔗 Quick Reference

| Layer       | Technology        | Port     | Purpose                                     |
| ----------- | ----------------- | -------- | ------------------------------------------- |
| **Gateway** | Node.js Cluster   | **3000** | **Identity & Routing (Single Entry Point)** |
| Frontend    | Next.js           | 3001     | SSR, Visual Editor                          |
| Backend     | Express.js (TypeScript, compiled) | 4000 | REST API, Plugins                  |
| Database    | SQLite/PostgreSQL | -        | Data Storage                                |

> For build/run commands and the dev vs prod workflow, see **[development.md](development.md)**.

---

## 🟦 Backend Runtime (TypeScript, compiled for production)

The backend is written in **TypeScript** (`backend/src/**/*.ts`). In **production it is compiled**: `npm run build` (`tsc -p tsconfig.build.json`, preceded by a `clean` of `dist/`) emits `dist/`, and the `server.js` supervisor runs `node dist/index.js`. `ts-node` is used **only** in development or as a convenience fallback when no `dist/` build exists.

- **Strict typecheck:** `backend/tsconfig.json` has `strict: true`, so the strict core is enforced (`strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `alwaysStrict`). Two sub-flags remain explicitly **OFF**: `noImplicitAny: false` and `useUnknownInCatchVariables: false`. These are not nearly done — enabling `noImplicitAny` today surfaces **~1,220 implicit-any sites** (mostly untyped parameters) that still need real annotations, so the flag stays off until those are worked through. `module: commonjs`, `moduleDetection: force`, `allowJs`.
- **Entry / supervisor:** `npm start` runs the `server.js` supervisor. It checks for `backend/dist/index.js`: if present it spawns `node dist/index.js` (compiled); otherwise it falls back to `node -r ts-node/register src/index.ts`. `npm run dev` uses `node --watch -r ts-node/register src/index.ts`.
- **In-tree `.js` files compiled via `allowJs`:** `src/core/db-admin/*` (the in-core DB migration/admin runner that used to be the `db-migration` plugin) and `src/core/plugin-worker.js` (the plugin isolate worker) are carried into `dist/` by `allowJs`.
- **DB drivers:** `src/drivers/` defines a driver interface (`interface.ts`: `connect/get/all/run/exec/close`) plus implementations (`sqlite-native`, `sqlite-legacy`, `postgres`, embedded). Adding a database = implement the interface + add a conformance block (`src/tests/driver-conformance.test.ts`).
- **Plugins stay JavaScript:** code under `backend/plugins/*` remains `.js` on purpose, because the acorn AST security scanner and dynamic `require` assume `.js`. Plugins are excluded from the build.
- **Tooling & CI:** ESLint (flat config) + Prettier, a `node:test` suite (`src/tests/*.test.ts`, including supertest API integration tests). CI (`.github/workflows/ci.yml`) runs **strict typecheck → build → license gate (block AGPL/SSPL) → tests** for the backend, gateway tests, and frontend lint + build.

---

## ⚡ Hybrid Plugin Architecture

WordJS uses a dual-mode loading system for plugins to optimize for both developer experience and production speed.

### Development Mode (`NODE_ENV=development`)
- **Frontend:** Uses **Next.js Dynamic Imports**.
- **Performance:** Supports Hot Module Replacement (HMR).
- **Latency:** Slightly higher initial load due to on-the-fly compilation.

### Production Mode (`NODE_ENV=production`)
- **Frontend:** Loads **Pre-compiled Bundles** via the Plugin API.
- **Performance:** Near-zero activation time. No `next build` required.
- **Sandboxing:** Bundles are evaluated in a blob URL context with React singleton injection.

---

## 🌐 Port Mapping Logic

To avoid CORS and simplify production deployments, all traffic should go through the Gateway on port **3000**.

- `http://localhost:3000/` → Handled by **Frontend** (3001)
- `http://localhost:3000/api/*` → Handled by **Backend** (4000)
- `http://localhost:3000/admin` → Handled by **Frontend** (3001)
- `http://localhost:3000/plugins/*` → Handled by **Backend** (4000)

---

## 🔒 Internal Security (mTLS)

WordJS services communicate securely using a private mTLS cluster.

```mermaid
graph LR
    subgraph "Internal Network"
        GatewayAPI[Gateway API :3100]
        Backend[Backend]
        Frontend[Frontend]
    end

    Backend -- "mTLS (CN=backend)" --> GatewayAPI
    Frontend -- "mTLS (CN=frontend)" --> GatewayAPI
    GatewayAPI -- "Trusts cluster CA" --> Backend
```

The **Gateway** runs a private mTLS server on the internal port (`gatewayInternalPort`, default **3100** = public port + 100). Services register and fetch info here over mutual TLS: every internal request must present a client certificate that chains to the cluster CA **and** whose CN is on the allow-list (`backend`, `frontend`, `gateway`, `gateway-internal`). `POST /register` (CN `backend`/`frontend`) updates the routing registry; `GET /info` (CN `backend`) returns gateway/SSL/cert status. The cluster CA and per-service certs are generated by the **setup orchestrator** (`setup/index.js`), so sensitive keys never travel over the public port.
