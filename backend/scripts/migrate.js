#!/usr/bin/env node
/**
 * Standalone schema-migration runner — applies any pending schema migrations to the configured
 * database WITHOUT starting the server. Invoked by `npm run migrate` (root) → setup --migrate.
 *
 * Useful in deploy pipelines (apply migrations before rolling out new code). Migrations ALSO run
 * automatically at boot, so this is idempotent. Switching DB *drivers* (copying data between
 * sqlite/postgres) is a separate operation in the admin panel (Admin → Database), not this command.
 *
 * Mirrors server.js / monolith.js: prefer compiled dist/, fall back to ts-node on src/.
 */
const path = require('path');
const fs = require('fs');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND); // config / data / certs resolve relative to backend/, like a normal boot

const distDb = path.join(BACKEND, 'dist', 'config', 'database.js');
const useDist = fs.existsSync(distDb);
if (!useDist) {
  require(require.resolve('ts-node/register', { paths: [BACKEND] }));
}
const resolveMod = (rel) => useDist
  ? require(path.join(BACKEND, 'dist', rel + '.js'))
  : require(path.join(BACKEND, 'src', rel));

(async () => {
  try {
    const { isInstalled } = resolveMod('core/configManager');
    if (!isInstalled()) {
      console.error('❌ Not installed yet — complete the install wizard before running migrations.');
      process.exit(1);
    }
    const { init, initializeDatabase } = resolveMod('config/database');
    console.log('🧬 Applying schema migrations to the configured database...');
    await init();
    await initializeDatabase(); // initializeSchema + runSchemaMigrations + divergence guard (idempotent)
    console.log('✅ Database schema is up to date.');
    process.exit(0);
  } catch (e) {
    console.error('❌ Migration failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
