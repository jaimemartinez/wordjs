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
function isInstalled() {
    return fs.existsSync(CONFIG_FILE);
}

module.exports = {
    getConfig,
    saveConfig,
    isInstalled,
    CONFIG_FILE
};
