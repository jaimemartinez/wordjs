# WordJS CLI Toolkit 🛠️

WordJS includes several utility scripts in `backend/cli/` plus a set of `npm` scripts in `backend/package.json` for building, running, and maintaining the backend.

> **Runtime model:** The backend is TypeScript. For **production** it now **compiles**: `npm run build` (`tsc -p tsconfig.build.json`) emits `dist/`, and `server.js` runs `dist/index.js` when that build exists. `ts-node` is used only in **development** (or when `dist/` hasn't been built yet) — `server.js` falls back to `node -r ts-node/register src/index.ts`. TypeScript `strict` is on (with `noImplicitAny` and `useUnknownInCatchVariables` staged sub-flags).
>
> **CLI scripts and ts-node:** any `cli/*` script that imports core modules (e.g. `require('../src/config/database')`, which resolves to `.ts`) must be run with ts-node registration, e.g. `node -r ts-node/register cli/force-sync-roles.js`. Scripts that only use plain dependencies (e.g. `check_plugins.js`, which uses `better-sqlite3` directly) run with plain `node`.

## 1. npm Scripts

Run from `backend/`.

| Script              | Command                                          | Purpose                                                              |
| :------------------ | :----------------------------------------------- | :------------------------------------------------------------------ |
| `npm start`         | `node server.js`                                 | Production launcher (supervisor). Runs `dist/index.js` if built, else falls back to ts-node. |
| `npm run dev`       | `node --watch -r ts-node/register src/index.ts`  | Development server with auto-reload via ts-node.                     |
| `npm run build`     | `tsc -p tsconfig.build.json`                      | Compile TypeScript to `dist/` for production (runs `clean` first).  |
| `npm run clean`     | removes `dist/`                                   | Wipe the compiled output (also runs automatically before `build`).  |
| `npm run typecheck` | `tsc --noEmit`                                    | Strict type-check with no emit (also run in CI).                    |
| `npm test`          | `node --test -r ts-node/register src/tests/*.test.ts` | Run the test suite (includes the DB **driver conformance** suite). |
| `npm run lint`      | `eslint "src/**/*.ts"`                            | Lint the backend.                                                   |
| `npm run format`    | `prettier --write "src/**/*.ts"`                  | Format the backend.                                                 |

> **CI gate:** continuous integration runs the strict typecheck + `build` + the test suite, plus a **license gate** (`license-checker --production --failOn 'AGPL;SSPL'`). The project and all packages are MIT-licensed; dual-licensed dependencies are listed in `THIRD-PARTY-NOTICES.md`.

> **`migrate` / `seed`:** `package.json` declares `npm run migrate` (`node -r ts-node/register src/database/migrate.ts`) and `npm run seed` (`.../seed.ts`). Note that database **schema creation** is performed by the DB manager at boot, and **engine migrations** (SQLite ↔ PostgreSQL) are driven at runtime through the DB-Admin API (`/api/v1/db-migration/*`, see below). See "Known gaps" if these script targets are missing in your checkout.

## 2. Role Manager (`cli/force-sync-roles.js`)

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

## 3. Plugin Diagnostic (`cli/check_plugins.js`)

**Use case:** A plugin is causing the server to crash or not loading, and you need to see what's physically active in the DB.

This script opens the default native SQLite file (`backend/data/wordjs-native.db`) with `better-sqlite3` and prints the `active_plugins` option. It has no TS imports, so plain `node` works:

```bash
cd backend
node cli/check_plugins.js
```

Other handy diagnostics in `cli/` include `list-users.js`, `inspect-roles.js`, `inspect-user.js`, `verify-roles.js`, `verify-activation.js`, and `dump-routes.js` (lists every registered Express endpoint). Those that import `src/config/database` need the `-r ts-node/register` flag.

## 4. Gateway Registry (`gateway/gateway-registry.json`)

**Use case:** Troubleshooting service discovery.

This is a **file**, not a script. It contains the current state of the Gateway's known services. Inspecting it helps verify whether the backend/frontend registered successfully.

## 5. Database Files & Maintenance

The database file depends on the active driver (selected by `db.driver` in `wordjs-config.json` — see `documentation/database.md`):

| Driver               | File / location                     | Notes                                            |
| :------------------- | :---------------------------------- | :----------------------------------------------- |
| `sqlite-native` (default) | `backend/data/wordjs-native.db` | `better-sqlite3`. The DB-manager default.        |
| `sqlite-legacy` (fallback) | `backend/data/wordjs.db`       | pure-JS WASM `sql.js`; same SQLite file format. Automatic fallback only. |
| `postgres`           | external PG, or embedded under `backend/data/postgres-embed` | Embedded Postgres is **opt-in** (`db.embedded: true`). |

You can open any SQLite file with a SQLite CLI or GUI (like *DB Browser for SQLite*) directly while the server is stopped.

### DB-Admin API (engine migration)

Switching DB engines and managing the embedded PostgreSQL server is done at runtime via the **DB-Admin** core module (`backend/src/core/db-admin/`, formerly the `db-migration` plugin), exposed under `/api/v1/db-migration/*` (requires the `manage_options` capability). See `documentation/api.md` § 6.6 for the endpoint list.

## 6. Known gaps

* The `migrate` / `seed` npm scripts point at `src/database/migrate.ts` and `src/database/seed.ts`. If those files are absent in your checkout, the scripts will fail — schema setup happens at boot and engine migrations run via the DB-Admin API instead.
