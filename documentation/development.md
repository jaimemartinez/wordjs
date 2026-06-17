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
| Frontend | `frontend` (`next`)      | 3001 | Next.js SSR + Puck editor              |
| Setup    | `setup/index.js`         | —    | One-shot installer / mTLS cert + config generator |

All public traffic should go through the **Gateway on 3000**; 4000 and 3001 stay internal.

---

## 📦 Install

- **Node:** v18 or higher (`backend/package.json` `engines.node >= 18`; CI runs on Node 20).

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
npm run dev        # node --watch -r ts-node/register src/index.ts
```

### Strict typecheck

```bash
cd backend
npm run typecheck  # tsc --noEmit
```

`tsconfig.json` has `strict: true` — `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, and `alwaysStrict` are all enforced. Two sub-flags are **deliberately staged off** for now and will be tightened file-by-file:

- `noImplicitAny: false` — remaining implicit-`any` params are to be annotated with real types, not blanket `any`.
- `useUnknownInCatchVariables: false` — catch bindings stay loose for now.

### Tests, lint, format

```bash
cd backend
npm test      # node --test -r ts-node/register src/tests/*.test.ts (node:test + supertest)
npm run lint  # eslint (flat config)
npm run format
```

The DB driver conformance suite (`src/tests/driver-conformance.test.ts`) runs every driver (`sqlite-native`, `sqlite-legacy`, `postgres`, embedded) against the shared interface (`src/drivers/interface.ts`: `connect/get/all/run/exec/close`). **Adding a new database** = implement that interface and add a conformance block.

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
```

In **production** the frontend loads plugin UI from pre-compiled bundles via the Plugin API (no `next build` of plugin code required); in **development** it uses Next.js dynamic imports with HMR.

---

## 🚀 Gateway

```bash
node gateway/src/index.js   # or, from gateway/: node src/index.js
cd gateway && npm test      # proxy + mTLS integration test (node:test)
```

Config lives in `gateway/gateway-config.json` (`gatewaySecret`, `gatewayPort`, `gatewayInternalPort`, `ssl`, `mtls`). See **[gateway.md](gateway.md)**.

---

## ▶️ Running all three at once

From the repo root:

```bash
npm run dev    # launches the gateway + backend (watch / ts-node)
# start the frontend separately if needed:
cd frontend && npm run dev
```

For a production-style local run, `npm start` uses `concurrently` to bring up the gateway, backend, and frontend together. (See the troubleshooting note below.)

> **Troubleshooting:** the root `start` / `prod:gateway` scripts invoke `node gateway.js`, but the gateway entry is actually `gateway/src/index.js`. If `npm start` fails to launch the gateway, start it directly with `node gateway/src/index.js` (matching the working `dev:gateway` script), or run each service in its own terminal.

---

## 🪺 Run modes: split vs monolith

The **same codebase** runs two ways. The modes are **switchable at any time** — both share the same `backend/wordjs-config.json`, the same database, `uploads`/`themes`/`plugins`, secrets, and the same public origin (`https://localhost:3000`), so **there is no migration to switch**. They are **mutually exclusive** (both bind the public port, default 3000) — run one or the other, not both. **Plugins stay isolated (worker threads) in both modes.**

| Mode         | Processes / ports                              | Dev               | Build             | Prod               |
| ------------ | ---------------------------------------------- | ----------------- | ----------------- | ------------------ |
| **Split** (default) | gateway `:3000` + backend `:4000` + frontend `:3001` | `npm run dev`     | per-service build | `npm start`        |
| **Monolith** | one process, one port `:3000` (`monolith.js`)  | `npm run dev:mono`| `npm run build:mono` | `npm run start:mono` |

### Split (default, 3 processes)

The default. The **gateway** (`:3000` public, a Node `cluster` reverse-proxy) sits in front of the **backend** (`:4000`) and **frontend** (`:3001`), and provides clustering, health-checks, load-balancing, an mTLS internal channel, and SSE-aware proxying. Run it with `npm run dev` (dev) / `npm start` (prod) as covered above.

### Monolith (1 process, 1 port)

The repo-root entrypoint **`monolith.js`** mounts the backend Express app (**with** its isolated worker-thread plugins) **and** the Next.js request handler **in-process** — no loopback proxy, no Node `cluster`, and no gateway `/register`. The gateway's still-needed cross-cutting concerns are re-implemented as **local middleware**: `helmet`, `compression` (skipping SSE), SEO rewrites (`/sitemap.xml` → `/api/v1/seo/sitemap.xml`, `/robots.txt` → `…/robots.txt`), and `X-Forwarded-Host` pinning for CSRF. It serves **one HTTPS port reusing the gateway's certificate** (HTTP fallback), plus a **loopback-only HTTP listener** for the frontend's server-side (SSR) API calls.

```bash
npm run dev:mono     # dev: Next dev HMR + ts-node backend
npm run build:mono   # compiles backend to dist/ + runs next build
npm run start:mono   # prod: runs the compiled build
```

Internally, the backend `src/index.ts` skips its self-listen and gateway self-register when embedded (`process.env.WORDJS_EMBEDDED='1'`, set by `monolith.js`) and instead exposes `initialize()`; `monolith.js` also sets `WORDJS_MODE='mono'`.

### Which to choose

- **Monolith** — the simplest single-artifact deploy: one VM/container, TLS via its built-in HTTPS or a single reverse proxy in front.
- **Split** — scale the services independently and get the gateway's clustering, health-checks, and load-balancing.

---

## 🔧 Setup orchestrator

`setup/index.js` is the autonomous installer/migrator. It generates the **mTLS cluster CA and per-service certificates** (CNs `backend`, `frontend`, `gateway`/`gateway-internal`) and writes the shared `gatewaySecret`/ports into both `backend/wordjs-config.json` and `gateway/gateway-config.json`.

```bash
npm run setup     # node setup/index.js --install
npm run migrate   # node setup/index.js --migrate
```

---

## 🤖 CI

`.github/workflows/ci.yml` runs three parallel jobs on every push/PR (Node 20):

- **Backend:** strict typecheck (`tsc --noEmit`) → **build** (`npm run build`) → **license gate** (`license-checker --production --failOn 'AGPL;SSPL'`) → tests.
- **Gateway:** tests (proxy + mTLS integration).
- **Frontend:** lint + production build.

The license gate keeps the distribution MIT-clean by failing on network-copyleft (AGPL/SSPL) production dependencies.
