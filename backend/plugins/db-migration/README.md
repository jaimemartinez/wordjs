# Database Migration Plugin 🔄

This plugin enables **Zero Data Loss** migration between different storage engines (drivers) for WordJS.

## Features

- **Real-Time Status:** Live progress updates during migration (tables processed, rows copied).
- **Atomic Swaps:** For SQLite-to-SQLite migrations, uses a `.tmp` file and atomic rename to ensure data integrity.
- **Failover Protection:** If the target database fails, the system automatically rolls back.
- **Supported Paths:**
    - SQLite Legacy -> SQLite Native
    - SQLite Legacy -> PostgreSQL
    - SQLite Native -> PostgreSQL
    - PostgreSQL -> SQLite Native (Downgrade)
    - PostgreSQL -> SQLite Legacy (Downgrade)

## Usage

1.  Navigate to **Admin > Plugins > DB Migration**.
2.  Choose your target driver.
3.  Click **Migrate** or **Upgrade**.
4.  The system will handle the rest!

## Technical Details

The migration core resides in `core/migration.js`. It performs the following steps:
1.  **Initialize Target:** Connects to the new database/file.
2.  **Schema Sync:** Recreates the table structure in the destination.
3.  **Data Stream:** Iterates through all tables and copies row-by-row (or in batches) to minimize RAM usage.
4.  **Verification:** Compares row counts between source and target.
5.  **Config Swap:** Updates `wordjs-config.json` to point to the new driver.
6.  **Restart:** Triggers a server restart to load the new driver.
