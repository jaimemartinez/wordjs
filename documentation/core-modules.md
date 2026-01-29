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

---

## 5. Hook System & Live Registry 🪝

**Location:** `backend/src/core/hooks.js`

The central event bus that allows Core and Plugins to communicate through Actions and Filters.

### Features
*   **Global Registry:** A unified dictionary of all active hooks in the system.
*   **Admin UI:** Accessible via **Settings -> Hooks Registry** (`/admin/hooks`).
*   **Live Monitoring:** A real-time timeline (using Server-Sent Events) to watch hooks fire as they happen.
*   **Empty State Handling:** Gracefully handles cases where no hooks are currently registered by showing clear "No Actions/Filters found" states.

### Key Components
*   `addAction(hook, callback, priority)`: Register a function to run at a specific event.
*   `addFilter(hook, callback, priority)`: Register a function to modify data.
*   `doAction(hook, ...args)`: Trigger an event.
*   `applyFilters(hook, value, ...args)`: Pass data through registered filters.

---

## 6. Analytics System 📊

**Location:** `backend/src/models/Analytics.js` + `backend/src/routes/analytics.js`

A native, privacy-focused analytics engine built directly into WordJS to track traffic and engagement without external dependencies (like Google Analytics).

### Architecture
*   **Database:** Uses a dedicated table `wordjs_analytics` optimized for high-volume write operations.
*   **Performance:** Uses `dbAsync` (SQLite WAL mode or Postgres) for non-blocking writes.
*   **Privacy:** Tracks anonymized sessions using **SHA-256 hashing** with daily rotation. Raw IP addresses are **never** stored, ensuring GDPR compliance.

### Key Features
1.  **Event Tracking:** Logs `page_view`, `api_call`, and custom `engagement` events.
2.  **Aggregation:** Provides a `getStats(period)` method to aggregate raw logs into daily/weekly metrics for the Dashboard chart.
3.  **Frontend Integration:** Includes a `<AnalyticsTracker />` component that automatically pings the server on route changes, handling Strict Mode debouncing and client-side navigation.

### API Endpoints
*   `POST /api/v1/analytics/track`: Public endpoint for reporting events (Beacon/Pixel).
*   `GET /api/v1/analytics/stats`: Protected admin endpoint for retrieving aggregated chart data.
