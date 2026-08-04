const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.resolve('wordjs-config.json');

// The install/migration guard consults this file on EVERY non-static request; without a cache that
// is 2–3 blocking syscalls + a JSON.parse serialized on the event loop per request. Cache the RAW
// read outcome and revalidate cheaply: saveConfig() (the only in-process writer) invalidates
// immediately, and a 1-syscall mtime check every CONFIG_TTL_MS catches external writers (the setup
// wizard on another process, scripts/node-join.js). Semantics of getConfig/isInstalled — including
// the fail-closed corrupt→installed behavior — are built on top and unchanged.
const CONFIG_TTL_MS = 2000;
let _cfgCache: { exists: boolean; parsed: any; parseError: boolean; mtimeMs: number; checkedAt: number } | null = null;

function invalidateConfigCache() { _cfgCache = null; }

function readConfigFile() {
    const now = Date.now();
    if (_cfgCache && now - _cfgCache.checkedAt < CONFIG_TTL_MS) return _cfgCache;
    let st = null;
    try { st = fs.statSync(CONFIG_FILE); } catch { /* missing */ }
    if (!st) {
        _cfgCache = { exists: false, parsed: null, parseError: false, mtimeMs: 0, checkedAt: now };
        return _cfgCache;
    }
    if (_cfgCache && _cfgCache.exists && _cfgCache.mtimeMs === st.mtimeMs) {
        _cfgCache.checkedAt = now;
        return _cfgCache;
    }
    let parsed = null, parseError = false;
    try {
        parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        parseError = true;
    }
    _cfgCache = { exists: true, parsed, parseError, mtimeMs: st.mtimeMs, checkedAt: now };
    return _cfgCache;
}

/**
 * Get the stored configuration
 * @returns {Object|null} The configuration object or null if not found
 */
function getConfig() {
    const f = readConfigFile();
    if (!f.exists) return null;
    if (f.parseError) {
        console.error('Failed to read config file: unreadable or malformed JSON');
        return null;
    }
    return f.parsed;
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
        invalidateConfigCache();
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
    const f = readConfigFile();
    if (!f.exists) return false;
    // Unreadable/corrupt config → report INSTALLED. Fail closed: a parse error must never reopen the
    // installer on a live site.
    if (f.parseError) return true;
    return isInstalledConfig(f.parsed);
}

module.exports = {
    getConfig,
    saveConfig,
    isInstalled,
    isInstalledConfig,
    invalidateConfigCache,
    CONFIG_FILE
};
