# Core Modules Reference 🧩

This document details the internal core modules of WordJS that handle critical system functions like stability, security, and database management.

## 1. CrashGuard 🛡️

**Location:** `backend/src/core/crash-guard.js`

CrashGuard is a stability mechanism designed to prevent "Boot Loops" caused by faulty plugins.

### How it works
1.  **Pre-Load:** Before a plugin is activated, `startLoading(slug)` writes a lock file to `backend/data/plugin_boot.lock`.
2.  **Post-Load:** If the plugin loads successfully, `finishLoading(slug)` deletes the lock.
3.  **Crash Detection:** On next boot, the system checks if a lock file exists (`checkPreviousCrash()`).
4.  **Recovery:** If a lock is found, the system assumes the plugin named in the lock caused a crash and **automatically disables it** before proceeding.

---

## 2. Embedded Database Manager 🐘

**Location:** `backend/src/core/embedded-db.js`

WordJS includes a zero-configuration PostgreSQL experience using `embedded-postgres`.

### Features
*   **Zero Config:** Automatically downloads and starts a local PostgreSQL binary if no external DB is configured.
*   **Port:** Runs on port `5433` (to avoid conflict with standard PG port 5432).
*   **Persistence:** Data stored in `backend/data/postgres-embed`.
*   **Security:** Automatically synchronizes the `postgres` user password with `config.db.password` on every boot.

---

## 3. Certificate Manager 🔒

**Location:** `backend/src/core/cert-manager.js`

Manages SSL/TLS certificates via Let's Encrypt (ACME) or manual uploads.

### Capabilities
*   **ACME Client:** Built-in client to request standard `HTTP-01` and `DNS-01` challenges.
*   **DNS-01 Support:** Provides TXT record values for verifying wildcards or local domains.
*   **Auto-Renewal:** (Roadmap) Intended to automate renewal flows.
*   **Custom Certs:** Supports uploading existing `.pem` files via the Admin UI.
*   **Configuration:** Updates `wordjs-config.json` with paths to the active keys and certs.

---

## 4. Plugin Test Runner 🧪

**Location:** `backend/src/core/plugin-test-runner.js`

Enforces quality control by running unit tests before enabling a plugin.

### Logic
*   **Trigger:** Called automatically when an admin attempts to **Activate** a plugin.
*   **Runner:** Spawns a child process with `node --test`.
*   **Enforcement:** If tests fail, the activation is **blocked**, preventing broken code from running in production.
*   **Scope:** Looks for `*.test.js` files in the plugin's `tests/` directory.

### Example Output
```text
🧪 Running tests for plugin 'my-plugin'...
   ✅ All tests passed (5/5)
```
