/**
 * WordJS - Crash Guard v2.0
 * Enhanced Boot Loop Prevention with:
 * 1. 3-Strike Rule: Don't disable on first crash (could be power outage)
 * 2. Runtime Blame System: Track async errors and blame the right plugin
 */

const fs = require('fs');
const path = require('path');

const LOCK_FILE = path.resolve(__dirname, '../../data/plugin_boot.lock');
const STRIKE_FILE = path.resolve(__dirname, '../../data/plugin_strikes.json');
const RUNTIME_BLAME_FILE = path.resolve(__dirname, '../../data/runtime_crash.lock');
const MAX_STRIKES = 3;

// Ensure data dir exists
const DATA_DIR = path.dirname(LOCK_FILE);
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
}

// ============================================
// Strike Management (3-Strike Rule)
// ============================================

/**
 * Get current strike count for a plugin
 */
function getStrikes(slug) {
    try {
        if (fs.existsSync(STRIKE_FILE)) {
            const strikes = JSON.parse(fs.readFileSync(STRIKE_FILE, 'utf8'));
            return strikes[slug] || 0;
        }
    } catch (e) { }
    return 0;
}

/**
 * Increment strike counter for a plugin
 * @returns {number} New strike count
 */
function addStrike(slug) {
    let strikes = {};
    try {
        if (fs.existsSync(STRIKE_FILE)) {
            strikes = JSON.parse(fs.readFileSync(STRIKE_FILE, 'utf8'));
        }
    } catch (e) { }

    strikes[slug] = (strikes[slug] || 0) + 1;

    try {
        fs.writeFileSync(STRIKE_FILE, JSON.stringify(strikes, null, 2), 'utf8');
    } catch (e) {
        console.error('[CrashGuard] Failed to write strike file:', e.message);
    }

    return strikes[slug];
}

/**
 * Clear strikes for a plugin (successful load resets counter)
 */
function clearStrikes(slug) {
    try {
        if (fs.existsSync(STRIKE_FILE)) {
            const strikes = JSON.parse(fs.readFileSync(STRIKE_FILE, 'utf8'));
            if (strikes[slug]) {
                delete strikes[slug];
                fs.writeFileSync(STRIKE_FILE, JSON.stringify(strikes, null, 2), 'utf8');
            }
        }
    } catch (e) { }
}

// ============================================
// Boot-Time Crash Detection
// ============================================

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
 * Also clears any strikes for this plugin (it loaded fine).
 */
function finishLoading(slug) {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
        // Successful load clears strikes
        clearStrikes(slug);
    } catch (e) {
        console.error('[CrashGuard] Failed to clear lock file:', e.message);
    }
}

/**
 * Check if the last boot crashed while loading a plugin.
 * Implements 3-Strike Rule: Only returns guilty plugin after MAX_STRIKES crashes.
 * 
 * @returns {{ slug: string, strikes: number, shouldDisable: boolean } | null}
 */
function checkPreviousCrash() {
    try {
        // 1. Check boot-time crash (lock file exists)
        if (fs.existsSync(LOCK_FILE)) {
            const content = fs.readFileSync(LOCK_FILE, 'utf8');
            const data = JSON.parse(content);
            const slug = data.plugin;

            // Add a strike
            const strikes = addStrike(slug);

            console.log(`⚠️ [CrashGuard] Crash detected during load of '${slug}'. Strike ${strikes}/${MAX_STRIKES}`);

            // Clear the lock for next attempt
            fs.unlinkSync(LOCK_FILE);

            if (strikes >= MAX_STRIKES) {
                console.error(`🚨 [CrashGuard] 3 STRIKES! Plugin '${slug}' will be disabled.`);
                return { slug, strikes, shouldDisable: true };
            } else {
                console.log(`🔄 [CrashGuard] Will retry loading '${slug}' (${MAX_STRIKES - strikes} attempts remaining)`);
                return { slug, strikes, shouldDisable: false };
            }
        }

        // 2. Check runtime crash (async error blamed a plugin)
        if (fs.existsSync(RUNTIME_BLAME_FILE)) {
            const content = fs.readFileSync(RUNTIME_BLAME_FILE, 'utf8');
            const data = JSON.parse(content);
            const slug = data.plugin;

            console.error(`🚨 [CrashGuard] Runtime crash blamed on '${slug}': ${data.error}`);

            // Runtime crashes are immediate disable (already past boot)
            fs.unlinkSync(RUNTIME_BLAME_FILE);
            return { slug, strikes: MAX_STRIKES, shouldDisable: true };
        }
    } catch (e) {
        console.error('[CrashGuard] Error reading lock file:', e.message);
    }
    return null;
}

// ============================================
// Runtime Blame System (Async Error Tracking)
// ============================================

/**
 * Extract plugin slug from error stack trace
 * Looks for paths containing /plugins/SLUG/
 */
function extractPluginFromStack(stack) {
    if (!stack) return null;

    // Match patterns like /plugins/my-plugin/ or \plugins\my-plugin\
    const patterns = [
        /[\/\\]plugins[\/\\]([a-zA-Z0-9_-]+)[\/\\]/,
        /[\/\\]themes[\/\\]([a-zA-Z0-9_-]+)[\/\\]/
    ];

    for (const pattern of patterns) {
        const match = stack.match(pattern);
        if (match) {
            const slug = match[1];
            // Prefix themes
            if (pattern.source.includes('themes')) {
                return `theme:${slug}`;
            }
            return slug;
        }
    }

    return null;
}

/**
 * Blame a plugin for a runtime crash
 * Called from uncaughtException/unhandledRejection handlers
 */
function blamePlugin(slug, error) {
    try {
        const data = {
            plugin: slug,
            error: error.message || String(error),
            stack: error.stack || '',
            timestamp: Date.now()
        };
        fs.writeFileSync(RUNTIME_BLAME_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.error(`🔥 [CrashGuard] Runtime crash blamed on plugin '${slug}'. Will disable on restart.`);
    } catch (e) {
        console.error('[CrashGuard] Failed to write blame file:', e.message);
    }
}

/**
 * Install global error handlers for runtime blame tracking
 * Should be called early in application startup
 */
function installRuntimeBlameHandlers() {
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('💥 Uncaught Exception:', error);

        const slug = extractPluginFromStack(error.stack);
        if (slug) {
            blamePlugin(slug, error);
        } else {
            console.error('[CrashGuard] Could not identify culprit plugin from stack trace.');
        }

        // Give time for file write, then exit
        setTimeout(() => process.exit(1), 100);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('💥 Unhandled Rejection:', reason);

        const error = reason instanceof Error ? reason : new Error(String(reason));
        const slug = extractPluginFromStack(error.stack);

        if (slug) {
            blamePlugin(slug, error);
        }

        // Don't exit for unhandled rejections (Node.js behavior)
        // But log the blame for potential future crash
    });

    console.log('🛡️ [CrashGuard] Runtime blame handlers installed.');
}

/**
 * Clear all locks (for clean shutdown)
 */
function clear() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
        if (fs.existsSync(RUNTIME_BLAME_FILE)) {
            fs.unlinkSync(RUNTIME_BLAME_FILE);
        }
    } catch (e) { }
}

module.exports = {
    startLoading,
    finishLoading,
    checkPreviousCrash,
    clear,
    // New exports
    installRuntimeBlameHandlers,
    blamePlugin,
    extractPluginFromStack,
    getStrikes,
    addStrike,
    clearStrikes,
    MAX_STRIKES
};
