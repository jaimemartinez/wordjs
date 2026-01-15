/**
 * WordJS - Crash Guard
 * Prevents Boot Loops by tracking which plugin is currently initializing.
 * If the server crashes during init, the lock file remains. 
 * On next boot, we detect the lock and disable the culprit.
 */

const fs = require('fs');
const path = require('path');

const LOCK_FILE = path.resolve(__dirname, '../../data/plugin_boot.lock');

// Ensure data dir exists
const DATA_DIR = path.dirname(LOCK_FILE);
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
}

/**
 * Record that we are about to load a plugin.
 * MUST be synchronous to ensure it hits disk before potential crash.
 */
function startLoading(slug) {
    try {
        const data = {
            plugin: slug,
            timestamp: Date.now()
        };
        fs.writeFileSync(LOCK_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {
        console.error('[CrashGuard] Failed to write lock file:', e.message);
    }
}

/**
 * Record that the plugin loaded successfully.
 */
function finishLoading(slug) {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (e) {
        console.error('[CrashGuard] Failed to clear lock file:', e.message);
    }
}

/**
 * Check if the last boot crashed while loading a plugin.
 * @returns {string|null} The slug of the guilty plugin, or null.
 */
function checkPreviousCrash() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const content = fs.readFileSync(LOCK_FILE, 'utf8');
            const data = JSON.parse(content);

            // Optional: Check timestamp age? 
            // If it's very old (e.g. > 1 hour), maybe ignore? 
            // No, safer to assume it's a crash.

            return data.plugin;
        }
    } catch (e) {
        console.error('[CrashGuard] Error reading lock file:', e.message);
    }
    return null;
}

/**
 * Clear the lock manually (e.g. on clean shutdown)
 */
function clear() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (e) { }
}

module.exports = {
    startLoading,
    finishLoading,
    checkPreviousCrash,
    clear
};
