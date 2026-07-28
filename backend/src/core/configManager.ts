const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.resolve('wordjs-config.json');

/**
 * Get the stored configuration
 * @returns {Object|null} The configuration object or null if not found
 */
function getConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return null;
    }
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error('Failed to read config file:', e);
        return null;
    }
}

/**
 * Save configuration to disk
 * @param {Object} config The configuration object to save
 * @returns {boolean} True on success
 */
function saveConfig(config: any) {
    try {
        const current = getConfig() || {};
        const newConfig = { ...current, ...config, updatedAt: new Date().toISOString() };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
        // Refresh the in-memory runtime config (siteUrl → CSRF/CORS allowed-origins, etc.) so a persisted
        // change takes effect WITHOUT a process restart. Otherwise a just-completed setup keeps its
        // boot-time siteUrl and every POST from the configured origin is CSRF-blocked until restart.
        try { require('../config/app').reloadFromFile?.(); } catch (e) { /* config not yet loaded (pre-boot) */ }
        return true;
    } catch (e) {
        console.error('Failed to write config file:', e);
        return false;
    }
}

/**
 * Check if the application is installed
 * @returns {boolean}
 */
/**
 * Does this config describe a site that has been through the installer?
 *
 * The config file's mere EXISTENCE is not proof: cluster enrollment (scripts/node-join.js) writes this
 * same file to carry the gateway wiring + mTLS paths onto a brand-new backend node that has never been
 * set up. Treating that as installed skipped the wizard, and the CMS bootstrap then seeded a default
 * administrator on a node already published through the gateway.
 *
 * So key off something only the installer writes: `installedAt`, or `dbDriver` for sites installed
 * before that marker existed (enrollment carries no database choice).
 *
 * Exported for tests — the predicate is pure, `isInstalled()` just supplies the file.
 */
function isInstalledConfig(cfg: any) {
    if (!cfg || typeof cfg !== 'object') return false;
    return !!(cfg.installedAt || cfg.dbDriver);
}

function isInstalled() {
    if (!fs.existsSync(CONFIG_FILE)) return false;
    try {
        return isInstalledConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    } catch (e) {
        // Unreadable/corrupt config → report INSTALLED. Fail closed: a parse error must never reopen the
        // installer on a live site.
        return true;
    }
}

module.exports = {
    getConfig,
    saveConfig,
    isInstalled,
    isInstalledConfig,
    CONFIG_FILE
};
