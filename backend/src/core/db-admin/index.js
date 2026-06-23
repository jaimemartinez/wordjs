/**
 * WordJS - Database Administration (core)
 *
 * Formerly the `db-migration` plugin. It is DB *infrastructure*, not a sandboxable feature plugin:
 * it runs schema migrations. That work must happen in the host process, around the DB lifecycle — it
 * cannot run in an isolated worker — so it lives in core and is wired in at boot instead of being loaded
 * through the plugin system. See documentation/plugin-isolation-proposal.md.
 */

const express = require('express');
const migration = require('./migration');
const { authenticate } = require('../../middleware/auth');
const { can } = require('../../middleware/permissions');

/**
 * Mount the DB-admin API on the given Express app. The admin menu item is a core entry in the
 * frontend Sidebar (href /admin/db-migration, a native route) — not a dynamic plugin menu — so it
 * is always available and never tied to plugin activation state.
 */
function register(app) {
    if (!app) return;

    const router = express.Router();
    router.use(authenticate);
    router.use(can('manage_options'));

    // Migration API
    router.get('/status', migration.getStatus);
    router.post('/migrate', migration.runMigration);
    router.post('/cleanup', migration.cleanup);

    app.use('/api/v1/db-migration', router);

    console.log('✅ DB Admin (core) loaded.');
}

module.exports = { register };
