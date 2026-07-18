# WordJS CLI Toolkit 🛠️

WordJS includes several utility scripts in `backend/cli/` plus a set of `npm` scripts in `backend/package.json` for building, running, and maintaining the backend.

> **Runtime model:** The backend is TypeScript. For **production** it now **compiles**: `npm run build` (`tsc -p tsconfig.build.json`) emits `dist/`, and `server.js` runs `dist/index.js` when that build exists. `ts-node` is used only in **development** (or when `dist/` hasn't been built yet) — `server.js` falls back to `node -r ts-node/register src/index.ts`. The strict core is enforced (`strictNullChecks`, `strictFunctionTypes`, `strictPropertyInitialization`, etc.), `noImplicitAny: true` is now **enforced**; one sub-flag remains **off**: `useUnknownInCatchVariables: false` (catch bindings stay `any`).
>
> **CLI scripts and ts-node:** any `cli/*` script that imports core modules (e.g. `require('../src/config/database')`, which resolves to `.ts`) must be run with ts-node registration, e.g. `node -r ts-node/register cli/force-sync-roles.js`. Scripts that only use plain dependencies (e.g. `check_plugins.js`, which uses `better-sqlite3` directly) run with plain `node`.

## 1. npm Scripts

Run from `backend/`.

| Script              | Command                                          | Purpose                                                              |
| :------------------ | :----------------------------------------------- | :------------------------------------------------------------------ |
| `npm start`         | `node server.js`                                 | Production launcher (supervisor). Runs `dist/index.js` if built, else falls back to ts-node. |
| `npm run dev`       | `node --watch -r ./scripts/dev-env.js -r ts-node/register src/index.ts` | Development server with auto-reload via ts-node. The `dev-env.js` preload forces `NODE_ENV=development` (unless already set) so the split-mode dev backend accepts the localhost frontend's credentialed CORS. |
| `npm run build`     | `tsc -p tsconfig.build.json`                      | Compile TypeScript to `dist/` for production (runs `clean` first).  |
| `npm run clean`     | removes `dist/`                                   | Wipe the compiled output (also runs automatically before `build`).  |
| `npm run typecheck` | `tsc --noEmit`                                    | Strict type-check with no emit (also run in CI).                    |
| `npm test`          | `node --test -r ts-node/register src/tests/*.test.ts` | Run the unit test suite (includes the DB **driver conformance** suite). |
| `npm run test:integration` | `node --test --test-force-exit -r ts-node/register src/tests-integration/*.test.ts` | Multi-node / endpoint integration tests (run in CI against real `postgres:16` + `redis:7`). |
| `npm run lint`      | `eslint "src/**/*.ts"`                            | Lint the backend.                                                   |
| `npm run format`    | `prettier --write "src/**/*.ts"`                  | Format the backend.                                                 |

> **CI gate:** continuous integration (Node 22) runs the strict typecheck + `build` + the unit test suite + the **integration suite** (`npm run test:integration`, against real `postgres:16` + `redis:7` service containers), plus a **license gate** (`license-checker --production --failOn 'AGPL;SSPL'`). The project and all packages are MIT-licensed; dual-licensed dependencies are listed in `THIRD-PARTY-NOTICES.md`.

> **`setup`:** the **root** `package.json` declares `npm run setup` (`node setup/index.js --install`), the one-shot **cluster install orchestrator**. It generates the mTLS cluster PKI (a 10-year **Root CA** plus 2-year **gateway-internal / backend / frontend** service certs, each with `localhost` / `127.0.0.1` + host SANs), mints a random `gatewaySecret` (32 bytes hex) and `jwtSecret` (64 bytes hex), writes/merges `backend/wordjs-config.json` and `gateway/gateway-config.json` (`ssl.enabled`, gateway port `3000` / internal port `3100`), and distributes the certs into each service's `certs/` dir. It does **not** seed the database or create the admin account — that happens later via the interactive install wizard on the frontend; the script finishes by telling the operator to run `npm run install:all` then `npm run dev`. (The hardcoded `adminUser`/`adminPassword` in the `--install` branch are unused placeholders, not real credentials.)

> **`migrate`:** the **root** `package.json` declares `npm run migrate` (`node setup/index.js --migrate`), which delegates to `backend/scripts/migrate.js`. It applies any pending **schema migrations** to the configured database without starting the server (prefers compiled `dist/`, falls back to ts-node on `src/`). It is **idempotent** — the same schema migrations also run automatically at boot — so it's safe to run in a deploy pipeline before rolling out new code. It does **not** switch DB *drivers* (the SQLite ↔ PostgreSQL data copy); that is a separate runtime operation in the **DB-Admin** API (`/api/v1/db-migration/*`, see below).

> **First-run install token:** when the **backend** boots while the instance is **not yet installed** (i.e. on `npm start` / `npm run dev`, *not* `npm run setup`), it prints a one-time install token to the console (banner `🔑 WordJS install token:`). That token gates the otherwise-unauthenticated pre-install endpoints `POST /setup/install` and `POST /setup/test-db` (supplied via the `x-install-token` header or an `installToken` body field), so a not-yet-installed instance can't be taken over by whoever reaches it first. The token is held **in memory only** — a fresh one is minted on each boot while the instance remains uninstalled. For headless/Docker deploys it is **also** mirrored to a `0600` file at `backend/data/install-token` and can be overridden via the `WORDJS_INSTALL_TOKEN` env var (which must be **≥ 16 chars**, or it is ignored with a warning and a random token is used instead). The file/token is cleared once the instance is installed.

## 2. One-Command Site Bootstrap (`npx create-wordjs`)

The **published npm package** `create-wordjs` (source in `packages/create-wordjs/`, MIT; its version is kept in lockstep with the release tag by the release workflow — currently `v1.6.2`) bootstraps a complete WordJS site from nothing with a single command — no clone, no build, no TypeScript compilation on your machine:

```bash
npx create-wordjs my-site
```

It (1) looks up the **latest pre-compiled release ZIP** from GitHub (`jaimemartinez/wordjs`, following the release-asset redirect), (2) extracts it into `my-site/` and installs the runtime dependencies (`npm run release:install` in the extracted bundle), then (3) mints a one-time install token and starts the monolith (`npm run start:mono`), printing a clickable `https://localhost:3000/install?token=…` URL — the browser install wizard takes over (pick SQLite / PostgreSQL, create the admin).

The token is passed to the backend via the `WORDJS_INSTALL_TOKEN` env var (24 random bytes = 48 hex chars; the backend accepts it because it is ≥ 16 chars — see § 1). A fresh release bundle ships **without** `gateway/gateway-config.json` (secrets are never bundled), so the CLI seeds a minimal `{ "ssl": true }` there to enable **self-signed HTTPS** on `:3000` (never overwriting an existing config); pass `--http` to serve plain HTTP (`WORDJS_HTTP=1`) instead. Plain Node, no TypeScript — the only runtime dependency is `adm-zip`. Requires **Node ≥ 20.9** and refuses to run into a non-empty target directory.

| Option | Purpose |
| :--- | :--- |
| `--zip <path-or-url>` | Use a local release ZIP (or a direct ZIP URL) instead of the GitHub API — handy offline or when rate-limited. |
| `--version <tag>` | Install a specific release tag (e.g. `v1.0.0`) instead of the latest (a bare `1.0.0` is accepted and prefixed with `v`). |
| `--http` | Serve plain HTTP instead of self-signed HTTPS (sets `WORDJS_HTTP=1`). |
| `--no-start` | Scaffold + install dependencies only; don't start the server. |
| `-h`, `--help` | Show usage. |

### Subcommands (beyond the default scaffold)

The default `npx create-wordjs <dir>` above installs a single-machine site. The same bin also has subcommands for **in-place upgrades** and **separate mode** (the three services on **different** machines), so the whole cluster can be stood up without cloning the repo:

| Command | Purpose |
| :--- | :--- |
| `npx create-wordjs <dir>` | Fresh single-machine install (monolith), as above. |
| `npx create-wordjs upgrade [dir]` | Replace the app code in an existing install with the latest release **in place**, preserving `wordjs-config.json`, gateway secrets, the database, and user-installed plugins. |
| `npx create-wordjs gateway [dir] [opts]` | Stand up a **separate-mode gateway**: fetches the release, then runs the bundled `scripts/cluster.js init` to mint the cluster CA + gateway certs and prints ready-to-paste `join` commands (with fresh single-use tokens). Key option: `--host <ip/dns>` (the address other machines dial to reach this gateway). |
| `npx create-wordjs join <role> [dir] [opts]` | Join **this** machine to a gateway as `backend` or `frontend`: fetches the release, then runs the bundled `scripts/node-join.js` to enroll over the token listener and register over mTLS. Options: `--gateway <ip/dns>`, `--token <join-token>`, `--ca-hash <sha256>` (MITM guard), `--advertise <ip/dns>` (this node's routable address), `--enroll-port <port>` (default 3101). Needs `openssl` on `PATH`. |

So `create-wordjs gateway` / `join` are the one-command equivalents of the in-repo `scripts/cluster.js` / `scripts/node-join.js` walkthrough in [§ 6a](#6a-cluster-enrollment-separate-mode-) below — see **[separate-mode.md](separate-mode.md)** for the full flow.

> Unlike the backend `cli/*` scripts below, `create-wordjs` is **not** run from the repo — it is a standalone npm bin invoked via `npx` on an end-user machine to *produce* a WordJS install. The in-repo scaffolders (§ 3, for plugin/theme *authors*) are a different tool.

## 3. Plugin & Theme Scaffolder + Packer (`cli/wordjs.js`)

The plugin-author DX tool. Plain Node — no ts-node registration needed. There is deliberately **no root npm alias**; invoke it directly from the **repo root**:

```bash
node backend/cli/wordjs.js create plugin my-plugin   # scaffold backend/plugins/my-plugin/
node backend/cli/wordjs.js create theme  my-theme    # scaffold backend/themes/my-theme/
node backend/cli/wordjs.js pack my-plugin --build    # zip a plugin for distribution
node backend/cli/wordjs.js help
```

Templates live in `backend/cli/templates/{plugin,theme}/` with `__SLUG__` / `__PASCAL__` / `__NAME__` placeholders (replaced in file names and contents).

### `create plugin <slug>`

Scaffolds a complete, activatable **isolated** plugin:

| File | What it is |
| :--- | :--- |
| `manifest.json` | `id`, `name`, **`"isolated": true`** (required — activation is rejected without it), requested `permissions` with reasons (granted by the admin on activation, default-deny), `frontend.adminPage` `{entry, slug}` and `frontend.puckComponents` `{entry}`. |
| `index.js` | The isolated-bridge idioms: `exports.init = function (wordjs) { const { options, http, adminMenu } = wordjs; ... }` with a public GET plus admin-gated POST/DELETE route (`{ auth: true, admin: true }`), slug-prefixed options storage, and `adminMenu.add`. JSDoc-typed against `backend/types/wordjs-bridge.d.ts`, so plain-JS authors get full IntelliSense. |
| `client/admin/page.tsx` | The admin page (starts with `// @ts-nocheck` + `"use client"` — **required** for committed plugin client files: the frontend CI type-checks the generated registries, which import these files directly). |
| `client/puck/<Pascal>Puck.tsx` | A Puck block: `export const puckComponentDef` + default-exported render, themed via an embedded `<style>` with `--wjs-*` token fallbacks. |

The CLI then prints the required flow: **restart the backend once** (new plugin folders are discovered at boot; from then on activation hot-loads them) → **activate** in `/admin/plugins` → regenerate the frontend registries:

```bash
node frontend/scripts/generate-admin-plugin-registry.js
node frontend/scripts/generate-puck-plugin-registry.js
```

> **Dev hot-reload:** with `NODE_ENV=development` (i.e. `npm run dev`), the backend watches every active isolated plugin's directory (`backend/src/core/plugin-dev-watch.ts`) and re-spawns its child process ~300 ms after a `.js`/`.json` save — the reload re-runs the full load pipeline including the AST security scan, so nothing is bypassed. Manual equivalent (admin-only, works in any environment): `POST /api/v1/plugins/:slug/reload`.

### `create theme <slug>`

Scaffolds `backend/themes/<slug>/` with a `theme.json` (including the `layout` structure config the public shell honors: `containerWidth`, `sidebar`) and a `style.css` pre-seeded with the **full `--wjs-*` token block** — the token contract, copied from `backend/themes/default/style.css` — plus a commented chrome section (`--wjs-nav-*` / `--wjs-footer-*` tokens and the `.wjs-header-*`/footer hooks; see `backend/themes/midnight-luxury/style.css` for a complete real example). Details in `documentation/themes.md` / `documentation/theming.md`.

### `pack <slug> [--build] [--out <dir>]`

Zips `backend/plugins/<slug>` into `<slug>.zip` with a single `<slug>/` root folder — the exact layout `POST /api/v1/plugins/upload` (Admin → Plugins → Add New) expects — excluding `node_modules/`, `data/`, `.git/` and `os-tmp/` (dependencies reinstall automatically on activation). With `--build` it first runs `backend/scripts/build-plugin.js <slug>` to pre-compile the frontend bundles into `dist/`. Output defaults to the current directory (`--out <dir>` to change).

## 4. Role Manager (`cli/force-sync-roles.js`)

**Use case:** You accidentally deleted the Administrator role or permissions are corrupted.

This script re-seeds the `wordjs_user_roles` option in the database from the default roles defined in `backend/src/config/app.ts` (`config.roles`). It imports core TS modules, so run it through ts-node:

```bash
cd backend
node -r ts-node/register cli/force-sync-roles.js
```

**Output:**
```
Initializing database connection...
Syncing roles to database...
Successfully synced roles! Subscribers now have access_admin_panel.
```

## 5. Plugin Diagnostic (`cli/check_plugins.js`)

**Use case:** A plugin is causing the server to crash or not loading, and you need to see what's physically active in the DB.

This script opens the default native SQLite file (`backend/data/wordjs-native.db`) with `better-sqlite3` and prints the `active_plugins` option. It has no TS imports, so plain `node` works:

```bash
cd backend
node cli/check_plugins.js
```

Other handy diagnostics in `cli/` include `list-users.js`, `inspect-roles.js`, `inspect-user.js`, `verify-roles.js`, `verify-activation.js`, and `dump-routes.js` (lists every registered Express endpoint). Those that import `src/config/database` need the `-r ts-node/register` flag.

## 6. Gateway Registry (`gateway/gateway-registry.json`)

**Use case:** Troubleshooting service discovery.

This is a **file**, not a script. It contains the current state of the Gateway's known services. Inspecting it helps verify whether the backend/frontend registered successfully.

## 6a. Cluster Enrollment (separate mode) 🪪

Two **root** scripts bootstrap **separate mode** — the gateway, backend, and frontend running on **different machines**, joined into one cluster over mutual TLS. They are aliased as `npm run cluster` and `npm run node:join`. The full operator walkthrough is **[separate-mode.md](separate-mode.md)**; the trust-root internals are in **[core-modules.md](core-modules.md)** § 10 (Cluster Certificate Authority).

### Gateway side (`scripts/cluster.js`, run **on the gateway machine**)

```bash
node scripts/cluster.js init   [--host <gw-ip/dns>] [--bind <ip>] [--port 3000] \
                               [--internal-port 3100] [--enroll-port 3101] [--site-url <url>]
node scripts/cluster.js token  <backend|frontend> [--host <node-ip>] [--ttl <minutes>]
node scripts/cluster.js tokens          # list outstanding join tokens
node scripts/cluster.js revoke-tokens   # burn all outstanding tokens
node scripts/cluster.js info            # show CA fingerprint + endpoints
```

* **`init`** mints the cluster CA (keeping the CA key `0600` on the gateway), mints the gateway's own identity + public cert (the public cert is now **also** signed by the cluster CA), writes a multi-node `gateway/gateway-config.json` (`gatewayInternalBind` = the routable IP, `gatewayEnrollPort` default **3101**), and clears the registry. Idempotent — re-running reuses the existing CA.
* **`token <role>`** mints a **single-use, role-bound, TTL** join token and prints the exact `node-join` command (including `--ca-hash`) to paste on the new machine.

### Node side (`scripts/node-join.js`, run **on the new backend/frontend machine**)

```bash
node scripts/node-join.js --role <backend|frontend> --gateway <gw-ip/dns> --token <join-token> \
     [--enroll-port 3101] [--advertise <this-node-ip>] [--ca-hash <sha256>] [--start]
```

It generates a keypair + CSR (via `openssl`), makes the **one** tokened `POST /enroll` call to the gateway's enrollment listener (port **3101** — a separate HTTPS listener that does **not** request a client cert; the strict mTLS `/register` listener on 3100 is untouched). The gateway validates the token, **forces `CN` = the token's role** (the CSR subject is ignored), signs the cert, and returns `{cert, cluster-ca, bootstrap config}`. `node-join` verifies the returned CA against `--ca-hash` (MITM guard), writes `<role>/certs/*` + `<role>/wordjs-config.json` (`advertiseHost`, `gatewayHost`, …), and with `--start` launches the service — which then **registers** with the gateway over mTLS.

## 7. Database Files & Maintenance

The database file depends on the active driver (selected by `dbDriver` in `wordjs-config.json` — see `documentation/database.md`):

| Driver               | File / location                     | Notes                                            |
| :------------------- | :---------------------------------- | :----------------------------------------------- |
| `sqlite-native` (default) | `backend/data/wordjs-native.db` | `better-sqlite3`. The DB-manager default.        |
| `sqlite-legacy` (fallback) | `backend/data/wordjs.db`       | pure-JS WASM `sql.js`; same SQLite file format. Automatic fallback only. |
| `postgres`           | external PostgreSQL server (via the `pg` client) | Set `db: { host, port, user, password, name, ssl }` in `wordjs-config.json`. |
| `mysql` (or `mariadb`) | external MySQL 8.0+ / MariaDB server (via the `mysql2` client) | Same `db` connection object (set `dbPort: 3306`); the driver translates SQLite-dialect SQL to MySQL at the boundary. |

You can open any SQLite file with a SQLite CLI or GUI (like *DB Browser for SQLite*) directly while the server is stopped.

### DB-Admin API (engine migration)

Switching DB engines is done at runtime via the **DB-Admin** core module (`backend/src/core/db-admin/`, formerly the `db-migration` plugin), exposed under `/api/v1/db-migration/*` (requires the `manage_options` capability). See `documentation/api.md` § 6.6 for the endpoint list.

## 8. Notes

* **`migrate` vs. engine migration:** `npm run migrate` (root) applies pending DB **schema** migrations via `backend/scripts/migrate.js` (idempotent; also run at boot). Switching DB **engines** (SQLite ↔ PostgreSQL data copy) is a separate runtime operation in the DB-Admin API (`/api/v1/db-migration/*`).
