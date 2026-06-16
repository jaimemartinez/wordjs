/**
 * WordJS - Database Administration (core)
 *
 * Formerly the `db-migration` plugin. It is DB *infrastructure*, not a sandboxable feature plugin:
 * it manages the embedded PostgreSQL server process (install/start/stop via child_process) and runs
 * schema migrations. That work must happen in the host process, around the DB lifecycle — it cannot
 * run in an isolated worker — so it lives in core and is wired in at boot instead of being loaded
 * through the plugin system. See documentation/plugin-isolation-proposal.md.
 */

const express = require('express');
const migration = require('./migration');
const embedded = require('./embedded');
const { authenticate } = require('../../middleware/auth');
const { can } = require('../../middleware/permissions');
const { registerAdminMenu } = require('../adminMenu');

/**
 * Mount the DB-admin API on the given Express app and register its admin menu.
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

    // Embedded PostgreSQL server API
    router.get('/embedded/status', embedded.getStatus);
    router.post('/embedded/install', embedded.install);
    router.post('/embedded/start', embedded.start);
    router.post('/embedded/stop', embedded.stop);

    app.use('/api/v1/db-migration', router);

    registerAdminMenu('db-migration', {
        href: '/admin/plugin/db-migration',
        label: 'DB Migration',
        icon: 'fa-exchange',
        order: 999,
        cap: 'manage_options',
        section: 'management'
    });

    console.log('✅ DB Admin (core) loaded.');
}

module.exports = { register };
