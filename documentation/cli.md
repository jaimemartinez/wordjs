# WordJS CLI Toolkit 🛠️

WordJS includes several utility scripts in the `backend/` root to help with maintenance and troubleshooting.

## 1. Role Manager (`cli/force-sync-roles.js`)

**Use case:** You accidentally deleted the Administrator role or permissions are corrupted.

This script wipes the `wordjs_user_roles` option in the database and re-initializes it with the default "Hardcoded" roles defined in `backend/src/core/roles.js`.

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
