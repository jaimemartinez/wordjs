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
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* best-effort: a later fs op surfaces a real failure */ }
}

// ============================================
// Strike Management (3-Strike Rule)
// ============================================

/**
 * The slug grammar the plugin routes validate on. A slug outside it never reaches the strike file.
 */
const STRIKE_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function isStrikeSlug(slug: any): boolean {
    return typeof slug === 'string' && STRIKE_SLUG_RE.test(slug);
}

/**
 * The strike file, as a Map.
 *
 * The slug reaching addStrike/clearStrikes comes from a request (uninstall purges strikes; the boot
 * recovery blames a slug read off disk), and `strikes[slug] = …` / `delete strikes[slug]` on a plain
 * object is a property write with a remote-controlled name — '__proto__' would mutate Object.prototype
 * for the whole process instead of counting a strike, and the JSON on disk is itself attacker-shaped
 * input, so even the READ side must not adopt inherited keys. A Map key is data, never a property, and
 * the grammar check drops anything that is not a plugin slug before it is used at all.
 */
function readStrikeMap(label: string): Map<string, number> {
    const m = new Map<string, number>();
    try {
        if (!fs.existsSync(STRIKE_FILE)) return m;
        const parsed = JSON.parse(fs.readFileSync(STRIKE_FILE, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return m;
        for (const [k, v] of Object.entries(parsed)) {
            if (isStrikeSlug(k) && Number.isFinite(Number(v))) m.set(k, Number(v));
        }
    } catch (e) {
        console.error(`[CrashGuard] Failed to parse strike file (${label}):`, e.message);
    }
    return m;
}

function writeStrikeMap(m: Map<string, number>) {
    try {
        fs.writeFileSync(STRIKE_FILE, JSON.stringify(Object.fromEntries(m), null, 2), 'utf8');
    } catch (e) {
        console.error('[CrashGuard] Failed to write strike file:', e.message);
    }
}

/**
 * Get current strike count for a plugin
 */
function getStrikes(slug: string) {
    if (!isStrikeSlug(slug)) return 0;
    return readStrikeMap('read').get(slug) || 0;
}

/**
 * Increment strike counter for a plugin
 * @returns {number} New strike count
 */
function addStrike(slug: string) {
    if (!isStrikeSlug(slug)) return 0;
    const strikes = readStrikeMap('write');
    const next = (strikes.get(slug) || 0) + 1;
    strikes.set(slug, next);
    writeStrikeMap(strikes);
    return next;
}

/**
 * Clear strikes for a plugin (successful load resets counter)
 */
function clearStrikes(slug: string) {
    if (!isStrikeSlug(slug)) return;
    const strikes = readStrikeMap('clear');
    if (strikes.delete(slug)) writeStrikeMap(strikes);
}

// ============================================
// Boot-Time Crash Detection
// ============================================

/**
 * Record that we are about to load a plugin.
 * MUST be synchronous to ensure it hits disk before potential crash.
 */
function startLoading(slug: string) {
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
function finishLoading(slug: string) {
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
function extractPluginFromStack(stack: string | undefined) {
    if (!stack) return null;

    // Match patterns like /plugins/my-plugin/ or \plugins\my-plugin\
    const patterns = [
        /[/\\]plugins[/\\]([a-zA-Z0-9_-]+)[/\\]/,
        /[/\\]themes[/\\]([a-zA-Z0-9_-]+)[/\\]/
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
function blamePlugin(slug: string, error: any) {
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

        // ATTRIBUTION CAVEAT: a non-Error rejection (a thrown string, number, or plain object) carries
        // NO stack from the original throw site. We synthesize an Error here, but its stack points at
        // THIS handler (crash-guard), not at the plugin that rejected. extractPluginFromStack will then
        // find no plugin frame and we cannot assign blame. So absence of blame here does NOT imply the
        // fault was in core — it may be an unattributable plugin rejection. Plugins should reject with
        // real Error objects to be blamed correctly.
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
    } catch (e) {
        console.error('[CrashGuard] Failed to clear locks:', e.message);
    }
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
