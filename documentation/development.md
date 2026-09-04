# Development & Build Guide 🛠️

This guide covers installing dependencies, the **compiled production build**, the strict TypeScript typecheck, and how to run the services in development versus production — in either the default **split** (gateway + backend + frontend) or the single-process **monolith** mode.

For the production server/firewall/SSL story see **[deployment.md](deployment.md)**; for the gateway internals see **[gateway.md](gateway.md)**; for the high-level picture see **[architecture.md](architecture.md)**.

---

## 🧩 Services

WordJS is three Node processes plus a setup orchestrator:

| Service  | Entry                    | Port | Notes                                  |
| -------- | ------------------------ | ---- | -------------------------------------- |
| Gateway  | `gateway/src/index.js`   | 3000 | Node cluster reverse proxy; internal mTLS server on `gatewayInternalPort` (default 3100) |
| Backend  | `backend/server.js` (supervisor) → `dist/index.js` or `src/index.ts` | 4000 | Express REST API + plugin sandbox |
| Frontend | `frontend` (`next`)      | 3001 | Next.js SSR + the Verso visual editor  |
| Setup    | `setup/index.js`         | —    | One-shot installer / mTLS cert + config generator |

All public traffic should go through the **Gateway on 3000**; 4000 and 3001 stay internal.

---

## 📦 Install

- **Node:** v20.9 or higher (every workspace's `package.json` declares `engines.node >= 20.9.0`; CI runs on Node 22). `monolith.js` preflights the running version and exits with a clear message on anything older (Next 16 + native modules need Node 20 LTS or 22 LTS).

Install every workspace's dependencies in one shot from the repo root:

```bash
npm run install:all
# = npm install (root) + backend + frontend + gateway + setup
```

---

## 🟦 Backend: dev vs prod

The backend is TypeScript. **Production is compiled** — `ts-node` is only used in development or as a fallback when no build exists.

### Build (production)

```bash
cd backend
npm run build      # prebuild cleans dist/, then: tsc -p tsconfig.build.json
```

`npm run build` emits `backend/dist/`. Because `tsconfig.build.json` extends `tsconfig.json`, the build runs the **strict** typecheck and **fails on any type error**. In-tree `.js` files (`src/core/db-admin/*`, `src/core/plugin-worker.js`) are carried into `dist/` via `allowJs`; tests, plugins, and themes are excluded from the shipped output.

### Run

```bash
cd backend
npm start          # node server.js (supervisor)
```

`server.js` is a self-healing supervisor. On launch it checks for `backend/dist/index.js`:

- **`dist/` exists** → spawns `node dist/index.js` (compiled — the production path).
- **no `dist/`** → falls back to `node -r ts-node/register src/index.ts` (dev convenience).

So **always run `npm run build` for production**; otherwise you silently get the slower `ts-node` path. The supervisor restarts the child on crashes (with a fast-crash circuit breaker), pairing with the in-process CrashGuard for a self-healing backend.

### Develop (watch + ts-node)

```bash
cd backend
npm run dev        # node --watch-path=./src -r ./scripts/dev-env.js -r ts-node/register src/index.ts
```

The dev script preloads `scripts/dev-env.js` first: it fail-safes `NODE_ENV` to `development` when unset, because `config/app.ts` now defaults `nodeEnv` to `production` (so a misconfigured deploy never boots in the relaxed mode). Without the preload the split-mode dev backend would boot in production mode and reject the localhost frontend's credentialed CORS requests.

Each `"isolated": true` plugin runs in a **separate OS process** (`child_process.fork` of `src/core/plugin-worker.js`, host: `src/core/plugin-isolate.ts`) — not a worker thread, and never in the host process — so a plugin crash/OOM is contained to the child. In **dev** the forked child must also load `ts-node` (core is `.ts`): `plugin-isolate.ts` detects this from its own `.ts` filename and passes `-r <resolved path to ts-node/register>` to the child's `execArgv` — the path is resolved with `require.resolve`, because on Linux and macOS the child is launched with its working directory at the filesystem root, where a bare specifier has no `node_modules` to resolve against; on a compiled `dist/` build no flag is needed. The same in-child runtime guards (`secure-require.ts`, `io-guard.ts`) and host-side bridge allowlist apply in both modes.

### Strict typecheck

```bash
cd backend
npm run typecheck  # tsc --noEmit
```

`tsconfig.json` has `strict: true` — `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, and `alwaysStrict` are all enforced. `noImplicitAny` is now enforced too; one sub-flag remains **off**:

- `noImplicitAny: true` — **enforced**. Every parameter/variable is annotated: real types where locally determinable, explicit `any` only at genuinely dynamic boundaries (plugin payloads, RPC/hook glue, request bodies). Annotation was type-only (zero runtime change).
- `useUnknownInCatchVariables: false` — catch bindings stay `any` for now.

### Tests, lint, format

```bash
cd backend
npm test                  # node ../scripts/test-with-flake-retry.mjs --test-force-exit --test-concurrency=1 -r ts-node/register/transpile-only src/tests/*.test.ts (node:test + supertest; transpile-only — types are checked by `npm run typecheck`)
npm run test:integration  # node ../scripts/test-with-flake-retry.mjs --test-force-exit -r ts-node/register src/tests-integration/*.test.ts (needs Postgres + Redis)
npm run lint              # eslint (flat config)
npm run format
```

Both test scripts run `node --test …` through `scripts/test-with-flake-retry.mjs` (repo root), a wrapper that re-runs the suite up to twice (three runs in all), and only when every failure in the run is node:test's known `--test-force-exit` deserialize flake ("Unable to deserialize cloned data …" reported against a file whose own suite passed). A run containing any real assertion failure is never retried.

`npm test` runs the backend unit suite across every `src/tests/*.test.ts` file (220 at the time of writing; node:test + supertest). `npm run lint` **is** a CI gate (the backend job runs it between the typecheck and the build; ESLint exits non-zero on errors only, so warnings are surfaced but tolerated). `npm run format` stays a local command.

The DB driver conformance suite (`src/tests/driver-conformance.test.ts`) runs the **async** drivers it has a dialect-descriptor block for (`sqlite-native`, `postgres`, and `mysql`, each skipped gracefully when its backend isn't reachable — and hard-failed in CI via `WORDJS_CI_DB=1`) against the shared interface (`src/drivers/interface.ts`: `connect/get/all/run/exec/transaction/close`). The `mysql` (`mysql2`) block feeds the same SQLite-dialect SQL and asserts the driver's translation layer. The legacy `sqlite-legacy` (sql.js) driver uses the older **sync** shape and is intentionally out of scope here. The 6th interface method, `transaction(fn)`, is an atomic `BEGIN`/`COMMIT`/`ROLLBACK` wrapper that passes a `tx` bound to a single connection (the basis of the atomic-transaction guarantee). **Adding a new database** = implement that interface (including `transaction()`) and add a conformance block.

The **integration suite** (`src/tests-integration/`, run by `npm run test:integration` and in CI against real `postgres:16` + `redis:7` containers) exercises the multi-node coordination paths and full-app endpoints: distributed-lock lease CAS against Postgres (`dist-lock.integration.test.ts`), Redis pub/sub coherence (`coherence.integration.test.ts`), and the health/metrics endpoints (`health.integration.test.ts`).

### Plugin frontends

Plugins ship pre-compiled frontend bundles for production. Build them once:

```bash
cd backend
node scripts/build-plugin.js --all
```

---

## ⚛️ Frontend: dev vs prod

```bash
cd frontend
npm run dev    # node scripts/start-frontend.js dev
npm run build  # next build
npm start      # node scripts/start-frontend.js prod
npm run lint   # eslint .
npm run test   # vitest run (unit tests, e.g. the XSS sanitizer in src/lib/__tests__/sanitize.test.ts)
```

In **production** the frontend loads plugin UI from pre-compiled bundles via the Plugin API (no `next build` of plugin code required); in **development** it uses Next.js dynamic imports with HMR.

### Public site: real SSR (Server Components)

Every public route under `frontend/src/app/(public)/` (home `page.tsx`, post `[slug]/`, category-permalink post `[slug]/[postSlug]/`, page `pages/[slug]/`, `search/`, and the draft `preview/[slug]/`) is an **async React Server Component** that fetches its content **on the server**, so the initial HTML sent to crawlers and the first paint already contain the real title/body — not the old client-only `useEffect` skeleton. `preview/[slug]/` is the one route that opts out of caching entirely (`dynamic = "force-dynamic"` + a cookie-forwarding, `no-store` fetch) and marks itself `noindex`, because it renders unpublished drafts.

- **Server-only data layer — `frontend/src/lib/server-api.ts`.** `serverFetch()` resolves the backend base URL the same way for both modes: monolith uses the in-process plain-HTTP loopback (`WORDJS_MONO_ORIGIN`, default `http://127.0.0.1:4000`); split reads the backend port from `wordjs-config.json` (default 4000); `INTERNAL_API_URL` overrides both. Content loaders (`getPostBySlug`, `getPosts`, `getSettings`, …) are wrapped in React `cache()`, so `generateMetadata()` and the page body share **one** request-scoped backend call instead of fetching the same post twice. The module also exposes SEO helpers (`buildPostMetadata`, `htmlToText`) that are server-safe (no DOM). **Import it only from Server Components / `generateMetadata` — never from a `"use client"` file.**
- **`x-forwarded-host` forwarding (gotcha).** SSR fetches hit the loopback origin, so `serverFetch` relays the inbound `x-forwarded-host` / `x-forwarded-proto` (read via `next/headers`) one more hop to the backend. Without this, the backend's host-based logic — the Site-URL/migration guard, the CSRF origin check, and canonical/OpenGraph/sitemap URLs — would see `localhost:4000` instead of the real public host and (e.g.) reject every SSR request with a `409 migration_required`.
- **Content rendering is server-side too.** `frontend/src/components/public/PostContent.tsx` and `HomeContent.tsx` receive the already-fetched data as **props** and are themselves **Server Components**: the editor-authored body renders through `frontend/src/components/content/ContentRenderer.tsx`, which walks `meta._puck_data` and dispatches to the shared, server-compatible block components in `frontend/src/components/content/blocks.tsx` (each wrapped in `SharedBlockShell`). Only the genuinely interactive pieces are client islands in that same directory — `AccordionBlock`, `TabsBlock`, `SearchBarBlock`, `AudioTransport`, `SelfHostedVideo`, `LocalizedDate`, `LegacyCarousels`, the nav/chrome islands (`NavMenuMobile`, `NavClickSubmenus`, `OffCanvasClient`, `BackToTop`, `TocScrollSpy`), the motion islands (`AnimatedShell`, `IxRuntimeIsland`, `ParticleField`), and `PluginBlockIsland`/`PluginBlockHeavy` for plugin/Symbol blocks — so their chunks code-split away from pages that don't use them. `frontend/src/lib/sanitize.ts` is a **shared** module (no `"use client"`), so `sanitizeHTML` is callable from a Server Component; the `typeof window` branches inside each export pick `sanitize-html` on the server and DOMPurify in the browser. The sanitized-HTML blocks still carry `suppressHydrationWarning` because the two libraries serialize style attributes slightly differently.
- **Metadata & 404s.** Each page exports `generateMetadata` (title template, description, canonical, OpenGraph/Twitter). Missing content calls `notFound()` for a real HTTP 404. Search is a **no-JS GET form** (`action="/search" method="get"`).

---

## 🚀 Gateway

```bash
node gateway/src/index.js   # or, from gateway/: node src/index.js
cd gateway && npm test      # node --test test/*.test.js: proxy/mTLS integration, registration,
                            # worker registry, cluster secret, rate limit, purge,
                            # security headers, dispatcher parity
```

Config lives in `gateway/gateway-config.json` (`gatewaySecret`, `gatewayPort`, `gatewayInternalPort`, `ssl`, `mtls`). See **[gateway.md](gateway.md)**.

---

## ▶️ Running all three at once

From the repo root:

```bash
npm run dev    # concurrently launches all three: gateway + backend (watch / ts-node) + frontend
```

`npm run dev` uses `concurrently` to bring up the gateway (`dev:gateway` → `cd gateway && node src/index.js`), backend (`dev:backend` → `npm run dev`), and frontend (`dev:frontend` → `npm run dev`) together, with `-k` so killing one tears down the rest.

For a production-style local run, `npm start` likewise uses `concurrently` to bring up the gateway (`prod:gateway` → `cd gateway && node src/index.js`), backend (`npm start`), and frontend (`npm start`) together.

> **Tip:** if you'd rather watch the logs of one service at a time, run each in its own terminal — e.g. `cd gateway && node src/index.js`, `cd backend && npm run dev`, `cd frontend && npm run dev` — instead of the combined `concurrently` script.

---

## 🪺 Run modes: split vs monolith

The **same codebase** runs two ways. The modes are **switchable at any time** — both share the same `backend/wordjs-config.json`, the same database, `uploads`/`themes`/`plugins`, secrets, and the same public origin (`https://localhost:3000`), so **there is no migration to switch**. They are **mutually exclusive** (both bind the public port, default 3000) — run one or the other, not both. **Plugins stay isolated (each `"isolated": true` plugin runs in a separate OS process via `child_process.fork`) in both modes.**

| Mode         | Processes / ports                              | Dev               | Build             | Prod               |
| ------------ | ---------------------------------------------- | ----------------- | ----------------- | ------------------ |
| **Split** (default) | gateway `:3000` + backend `:4000` + frontend `:3001` | `npm run dev`     | per-service build | `npm start`        |
| **Monolith** | one process, one port `:3000` (`monolith.js`)  | `npm run dev:mono`| `npm run build:mono` | `npm run start:mono` |

### Split (default, 3 processes)

The default. The **gateway** (`:3000` public, a Node `cluster` reverse-proxy) sits in front of the **backend** (`:4000`) and **frontend** (`:3001`), and provides clustering, health-checks, load-balancing, an mTLS internal channel, and SSE-aware proxying. Run it with `npm run dev` (dev) / `npm start` (prod) as covered above.

### Monolith (1 process, 1 port)

The repo-root entrypoint **`monolith.js`** mounts the backend Express app (**with** its isolated plugins — each runs in its own forked OS process, never in-process) **and** the Next.js request handler **in-process** — no loopback proxy, no Node `cluster`, and no gateway `/register`. The gateway's still-needed cross-cutting concerns are re-implemented as **local middleware**: `helmet`, `compression` (skipping SSE), SEO rewrites (`/sitemap.xml` → `/api/v1/seo/sitemap.xml`, `/robots.txt` → `…/robots.txt`), and `X-Forwarded-Host` pinning for CSRF. It serves **one HTTPS port reusing the gateway's certificate** (HTTP fallback; set **`WORDJS_HTTP=1`** to force the public port to plain HTTP — `resolveSSL()` returns no cert), plus a **loopback-only HTTP listener** for the frontend's server-side (SSR) API calls.

```bash
npm run dev:mono     # dev: Next dev HMR + ts-node backend
npm run build:mono   # compiles backend to dist/ + runs next build
npm run start:mono   # prod: runs the compiled build
```

Internally, the backend `src/index.ts` skips its self-listen and gateway self-register when embedded (`process.env.WORDJS_EMBEDDED='1'`, set by `monolith.js`) and instead exposes `initialize()`; `monolith.js` also sets `WORDJS_MODE='mono'`.

### Which to choose

- **Monolith** — the simplest single-artifact deploy: one VM/container, TLS via its built-in HTTPS or a single reverse proxy in front.
- **Split** — scale the services independently and get the gateway's clustering, health-checks, and load-balancing (all three on **one** host).
- **Separate mode** — the split spread across **different** machines, joined via gateway-minted join tokens (mTLS). See [Separate mode (multi-node)](#-separate-mode-multi-node) below.

---

## 🔧 Setup orchestrator

`setup/index.js` is the autonomous installer/migrator. It generates the **mTLS cluster CA and per-service certificates** (CNs `gateway-internal`, `backend`, `frontend`) and writes the shared `gatewaySecret`/ports into both `backend/wordjs-config.json` and `gateway/gateway-config.json`.

```bash
npm run setup     # node setup/index.js --install
npm run migrate   # node setup/index.js --migrate
```

`npm run migrate` delegates to `backend/scripts/migrate.js`: it applies any pending DB **schema** migrations to the configured database without booting the server (compiled `dist/` if present, else ts-node on `src/`). It is **idempotent** — the same migrations also run automatically at boot — so it's safe to run ahead of a rollout in a deploy pipeline. It does **not** switch DB *drivers* (the SQLite ↔ PostgreSQL data copy); that is a separate runtime operation in the admin **DB Migration** route (`/api/v1/db-migration/*`).

---

## 🌐 Separate mode (multi-node)

Beyond the on-one-host **split** and single-process **monolith** above, the three services can run on **different machines**, joined into one cluster over mutual TLS. Instead of hand-copying certs, the gateway acts as the cluster CA and issues each node an identity via a **single-use join token** (kubeadm-style). Two **root** scripts drive it:

```bash
# On the gateway machine (mints the cluster CA + a role-bound token):
npm run cluster init                 # = node scripts/cluster.js init
npm run cluster token backend        # print the paste-ready node-join command

# On the new backend/frontend machine (one tokened /enroll call → mTLS identity):
npm run node:join -- --role backend --gateway <gw-ip> --token <token> --ca-hash <sha256> --advertise <this-ip> --start
```

The joining node generates a CSR, calls the gateway's token-enrollment listener (`gatewayEnrollPort`, default **3101** — separate from the strict mTLS `/register` listener on 3100), and receives a signed `CN=<role>` cert + the cluster CA + bootstrap config; it then registers over mTLS and the gateway starts proxying to it. The **canonical guide** is **[separate-mode.md](separate-mode.md)**; the scripts are detailed in **[cli.md](cli.md)** § 6a and the trust root in **[core-modules.md](core-modules.md)** § 10.

---

## 📥 WordPress importer (WXR)

To migrate an existing WordPress site, import its **WXR** export (the `Tools → Export` `.xml`). The importer maps WordPress entities onto WordJS models:

| WordPress     | WordJS                                                            |
| ------------- | ---------------------------------------------------------------- |
| `wp:author`   | `users` (random password — must be reset; matched by login/email) |
| `wp:category` | `terms` (taxonomy `category`, with parent hierarchy)             |
| `wp:tag`      | `terms` (taxonomy `post_tag`)                                    |
| `item`        | `posts`/`pages` (+ post meta, term relationships, threaded comments) |

- **Core:** `backend/src/core/wxr-import.ts` exposes `parseWxr`, `analyzeWxr` (dry-run counts), and `importWxr`.
- **Routes** (`backend/src/routes/import.ts`, admin-only, `multipart` field `file` = the `.xml`):
  - `POST /api/v1/import/wordpress/analyze` — dry-run; parses and returns entity counts without writing anything.
  - `POST /api/v1/import/wordpress` — runs the import. Form options: `defaultAuthorId` (defaults to the importing admin), `importComments` (`1`/`0`, default on), `importAttachments` (`1`/`0`, default off).
- **Admin UI:** `/admin/import` (sidebar **Import** in `frontend/src/components/Sidebar.tsx`).

Behaviour: **idempotent / re-runnable** — existing users (by login/email), terms (by slug+taxonomy) and posts (by slug+type) are matched and reused, not duplicated; the import is deliberately **not** wrapped in one DB transaction (it's resumable and per-item failures are collected, not fatal). Original publish dates are preserved, and classic-editor content gets a light `wpautop`. It **skips attachments** by default (the WXR carries only media URLs, not the binaries), spam/pingback comments, and `nav_menu_item` entries.

---

## 🤖 CI

`.github/workflows/ci.yml` runs eight parallel jobs on every push/PR (Node 22):

The backend, gateway, frontend, and install-channel (`packages/create-wordjs`) jobs each run an **audit gate** — `node scripts/ci-audit.mjs`, a wrapper that runs `npm audit --omit=dev --audit-level=high --json` in the job's working directory with a per-attempt timeout and one retry — that fails on any high/critical **production** dependency CVE (and on any unrecognised audit failure). Only a confirmed npm advisory-service outage across both attempts is allowed through: the step then emits `::warning::` annotations and passes, so a registry outage does not make the whole repository un-mergeable. Then:

- **Gates that travel (`gates-travel`):** a checkout-only job (no npm, no database) that asserts every file on an explicit manifest of required gates is present and tracked by git, and that every tracked test file is actually run by one of the suites this workflow invokes — plus a check that every job in every workflow declares a `timeout-minutes` (GitHub's default is six hours, where a hang is indistinguishable from a slow run).
- **Backend:** audit gate → strict typecheck (`tsc --noEmit`) → **lint** (`npm run lint`) → **build** (`npm run build`) → the seven **phase verifiers** `npm run verify:f0` … `verify:f6` (one per ADR under `documentation/adr/`, sources in `backend/scripts/verify-f*.ts`) → **license gate** (`license-checker --production --failOn 'AGPL;SSPL'`) → unit tests (run with `WORDJS_CI_DB=1` against a `mysql:8` service container, so the `postgres` + `mysql` driver-conformance blocks **hard-fail** instead of skipping — the only CI coverage of the SQLite→MySQL translation layer) → the **F0 content performance budgets** (`npm run perf:f0`, enforced against `backend/f0-performance-budgets.json`) → **integration tests** (`npm run test:integration`) against real `postgres:16` + `redis:7` service containers → **marketplace catalog integrity** (re-runs `node backend/scripts/build-marketplace.js`, then `node backend/scripts/verify-marketplace.js --rebuild`: it re-hashes every zip on disk against its catalog entry's sha256/size, compares the manifest inside each zip with the entry, requires every declared frontend entry to have its compiled `dist/*.bundle.js` in the package, rejects packages carrying a plugin's runtime `data/` or exceeding the installer's 10MB cap, rejects unreferenced leftovers in `dist/`, and — via `--rebuild` — requires a second build of unchanged sources to be byte-identical. `marketplace/dist/` is a gitignored build artifact published as Release assets by `release.yml`, not committed to the repo).
- **Multi-node coherence (`multinode`):** boots two backend cores as **separate OS processes** against one shared `postgres:16` + `redis:7` (`npm run test:multinode`) and asserts that an option/role change written on node A is observed on node B through the Redis bus — the cross-process path the single-process `coherence.integration.test.ts` cannot cover. It also `docker compose config -q`-validates the container stack.
- **Gateway:** audit gate → tests (`node --test test/*.test.js`).
- **Install channel (`install-channel`):** `packages/create-wordjs`, the `npx create-wordjs` installer published to npm — audit gate → its own `npm test` (`node --test test/*.test.js`), wrapped in a guard that fails the step if the run reported zero tests (so a glob that matches no files cannot pass by absence) → `node index.js --help` to prove the published bin still boots. This is the only job that audits the `create-wordjs` package's dependencies (the workspace-level audits do not cover it).
- **Frontend:** audit gate → **generate plugin registries** (`generate-plugin-registry.js` + `generate-admin-plugin-registry.js` + `generate-verso-plugin-registry.js`, so type-check/lint/build only reference the checked-out plugins) → two **anti-drift gates** that regenerate a committed artifact and `git diff --exit-code` it (`backend/public/theme-tokens.json` via `scripts/generate-token-manifest.js`, and `frontend/src/lib/assetVersion.generated.ts` via `scripts/generate-asset-version.js`), each preceded by a `git ls-files --error-unmatch` guard so the diff can never be vacuously green on an untracked file → strict typecheck (`tsc --noEmit`) → lint → **vitest** (`npm run test`) → production build (`next build`). (There is no vendored-editor build step any more: Verso is plain in-tree source under `frontend/src/components/verso/` + `frontend/src/lib/verso/`, compiled by `next build` like the rest of the app.)
- **Verso E2E (`verso-e2e`):** Playwright (chromium, headless) against an ephemeral plain-HTTP monolith that Playwright's own `webServer` starts (`npm run dev:mono` with `WORDJS_HTTP=1`); the `setup` project installs the instance through `WORDJS_INSTALL_TOKEN` and logs in by API, sharing `storageState` with the specs. Traces are uploaded as an artifact on failure.
- **Compiled-bundle smoke-boot (`bundle-boot`):** builds the real release bundle (`npm run bundle-release`) and **deploys it in every mode** — monolith, split, and cluster enrollment — via `scripts/smoke-deploy.sh`, so a file that lives in `src/` but is stripped from the compiled `dist/` fails the PR instead of the release. This is the only job that runs the packaged **compiled** artifact rather than `ts-node` source; it mirrors the same step in `release.yml`.

The license gate keeps the distribution MIT-clean by failing on network-copyleft (AGPL/SSPL) production dependencies.

Two more workflows gate the same push/PR: **`.github/workflows/sandbox-parity.yml`** certifies the production plugin-sandbox launch path on real kernels across four runners (Linux current + Ubuntu 22.04 for Landlock+seccomp, macOS 14 for Seatbelt, Windows for AppContainer) via `backend/scripts/verify-sandbox-parity.mjs`, which loads the **compiled** `backend/dist/core` modules rather than a duplicate probe; and **`.github/workflows/f6-certification.yml`** re-runs the phase suites against all three database engines and guards the certification matrix against being quietly shrunk. **`.github/workflows/flake-hunt.yml`** is `workflow_dispatch`-only — a diagnostic that re-runs the backend suite N times, not a gate. **`.github/workflows/dependency-audit.yml`** runs on a schedule instead of on push/PR: daily at 04:41 UTC (plus `workflow_dispatch`) it runs the same `ci-audit.mjs` gate across **all six** workspaces — including the root and `setup`, which `ci.yml` does not audit — and, when a leg fails, opens or comments on a `Dependency audit failed (<date>)` issue naming the affected workspaces and linking the run.

A separate **`.github/workflows/codeql.yml`** runs **CodeQL** static analysis (SAST, `security-and-quality` queries, JavaScript/TypeScript) on push/PR to `main` and on a weekly schedule, reporting findings to the repo's **Security** tab without blocking merges.

---

## 📦 Building a downloadable release

WordJS ships **pre-compiled** downloadable bundles so recipients never have to build. To produce one locally:

```bash
npm run install:all     # install every workspace (needs dev deps — the build compiles TS/Next)
npm run bundle-release   # = node scripts/make-release.js
```

`scripts/make-release.js` builds the frontend (`next build` → `.next`), compiles the backend (`tsc` → `dist/`), bundles the plugins (`node scripts/build-plugin.js --all`), then zips **everything except** `node_modules`, secrets, local config (`wordjs-config.json`, certs, DB, logs) and the `marketplace/` tree (marketplace plugins are distributed as separate release assets, never inside the core bundle) into **`release/wordjs-compiled-release.zip`** (with a self-contained `INSTALL.md` written into the bundle).

Marketplace plugins (sources under `marketplace/plugins/`) are packaged separately by `npm run build:marketplace` (= `node backend/scripts/build-marketplace.js`), which emits **deterministic** per-plugin zips plus `marketplace-index.json` (sha256 per entry, fixed zip timestamps, no generated-at field) into `marketplace/dist/` — a **gitignored build artifact**, not committed. The release workflow publishes it as **GitHub Release assets**, and the backend's default marketplace source is `releases/latest/download/` (admin-overridable via the `marketplace_sources` option); the admin **Marketplace** tab consumes that catalog (see `documentation/deployment.md`). CI re-runs the builder to confirm it still builds deterministically (see § CI above).

The recipient unzips, then — **no build step** — runs `npm run release:install` (installs runtime deps only, `--omit=dev`), starts with `npm run start:mono` (single process, default `https://localhost:3000`) or `npm start` (3-service split), and finishes in the browser install wizard (pick a database — SQLite, PostgreSQL, or MySQL/MariaDB — and create the admin). No secrets ship; they're generated locally at install.

In CI, pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs `npm run ci:all` (the CI counterpart of `install:all` — `node scripts/ci-install.mjs`, a parallel `npm ci` across the five workspaces) + `bundle-release`, then `npm run build:marketplace`, and publishes a GitHub Release with `wordjs-<tag>.zip` **plus the marketplace assets** (`marketplace/dist/*` — one zip per plugin + `marketplace-index.json`) and a **CycloneDX SBOM** (`wordjs-sbom.cdx.json`, generated by a SHA-pinned `anchore/sbom-action` step) attached; `workflow_dispatch` builds the same bundles as workflow artifacts only (`wordjs-compiled-release` + `wordjs-marketplace`, no Release). On version tags a second job publishes `create-wordjs` to npm (version synced to the tag; skipped cleanly when the `NPM_TOKEN` secret is not configured).

---

## 🔭 Deferred dependency migrations

Most dependency bumps are applied, but two larger migrations are **deferred and tracked as open PRs**, so don't be surprised that the tree is still on the older majors:

- **Express 4 → 5** (backend + gateway).
- **TypeScript 5 → 6** (frontend).
