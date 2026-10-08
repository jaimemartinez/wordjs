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
// accountAuthorityOnly: a migration copies EVERY table (the password hashes, the two-factor seeds in
// user_meta, the API token hashes, the plugins' secrets) to the database server the request names, then
// rewrites the site's config so the site RUNS on that server — whoever controls it decides from then on
// which accounts exist and with what password. That is the authority a backup restore needs and more, so
// it is refused to an API token and to a session started at an address other than the main one, before
// anything is read or connected (middleware/auth.ts refuseAccountAuthority). POST /cleanup deletes
// database files from data/ — irreversible, and before migration.js belongsToActiveDatabase existed it
// deleted the live one on request — so it takes the same gate: an interactive session at the main address.
const { authenticate, accountAuthorityOnly } = require('../../middleware/auth');
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
    router.post('/migrate', accountAuthorityOnly, migration.runMigration);
    router.post('/cleanup', accountAuthorityOnly, migration.cleanup);

    app.use('/api/v1/db-migration', router);

    console.log('✅ DB Admin (core) loaded.');
}

module.exports = { register };
