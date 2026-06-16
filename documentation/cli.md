# WordJS CLI Toolkit 🛠️

WordJS includes several utility scripts in `backend/cli/` to help with maintenance and troubleshooting.

> **Note:** The backend is now TypeScript, run via `ts-node` (no build step). CLI scripts that import core modules require ts-node registration, e.g. `node -r ts-node/register cli/force-sync-roles.js`.

## 1. Role Manager (`cli/force-sync-roles.js`)

**Use case:** You accidentally deleted the Administrator role or permissions are corrupted.

This script wipes the `wordjs_user_roles` option in the database and re-initializes it with the default "Hardcoded" roles defined in `backend/src/core/roles.ts`.

```bash
cd backend
node cli/force-sync-roles.js
```

**Output:**
```
🔄 Force Syncing Roles...
✅ Administrator role reset.
...
🎉 Roles synced successfully!
```

## 2. Plugin Diagnostic (`check_plugins.js`)

**Use case:** A plugin is causing the server to crash or not loading, and you need to see what's physically installed versus what's in the DB.

```bash
cd backend
node cli/check_plugins.js
```

## 3. Gateway Registry (`gateway-registry.json`)

**Use case:** Troubleshooting service discovery.

This is a **file** not a script, but it contains the current state of the Gateway's known services. Inspecting this file helps verify if the backend/frontend registered successfully.

## 4. Database Maintenance

The database is a simple file at `backend/data/wordjs.db`.
You can use any SQLite CLI or GUI (like *DB Browser for SQLite*) to open it directly if the server is stopped.

### npm Scripts

Migration and seeding are exposed as `package.json` scripts (run via ts-node):

```bash
cd backend
npm run migrate   # node -r ts-node/register src/database/migrate.ts
npm run seed      # node -r ts-node/register src/database/seed.ts
```
