/**
 * WordJS - Secure Require System
 * Runtime interception of sensitive Node.js modules for plugin sandboxing.
 * 
 * This module provides proxied versions of 'fs' and 'child_process' that
 * check permissions at RUNTIME, making the security system immune to code obfuscation.
 */

const { getCurrentPlugin, hasPermission } = require('./plugin-context');
const originalFs = require('fs');
const originalChildProcess = require('child_process');
const path = require('path');

// ============================================
// Security Configuration
// ============================================

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');
const THEMES_DIR = path.resolve(__dirname, '../../themes');

// Methods that require filesystem:read permission
const FS_READ_METHODS = [
    'readFile', 'readFileSync', 'readdir', 'readdirSync',
    'createReadStream', 'stat', 'statSync', 'lstat', 'lstatSync',
    'existsSync', 'access', 'accessSync', 'realpath', 'realpathSync',
    'readlink', 'readlinkSync', 'opendir', 'opendirSync'
];

// Methods that require filesystem:write permission
const FS_WRITE_METHODS = [
    'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'createWriteStream', 'mkdir', 'mkdirSync', 'rmdir', 'rmdirSync',
    'unlink', 'unlinkSync', 'rm', 'rmSync', 'rename', 'renameSync',
    'copyFile', 'copyFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
    'truncate', 'truncateSync', 'utimes', 'utimesSync', 'link', 'linkSync',
    'symlink', 'symlinkSync', 'open', 'openSync', 'close', 'closeSync',
    'write', 'writeSync', 'ftruncate', 'ftruncateSync'
];

// All child_process methods are BLOCKED for plugins
const CHILD_PROCESS_BLOCKED = [
    'exec', 'execSync', 'execFile', 'execFileSync',
    'spawn', 'spawnSync', 'fork'
];

// ============================================
// Helper Functions
// ============================================

/**
 * Check if a path is within the plugin's own directory
 */
function isPathWithinPluginDir(pluginSlug, targetPath) {
    if (!pluginSlug) return true;

    const resolvedPath = path.resolve(targetPath);

    // Plugin can access its own directory
    const pluginDir = path.join(PLUGINS_DIR, pluginSlug);
    if (resolvedPath.startsWith(pluginDir)) {
        return true;
    }

    // Theme can access its own directory
    if (pluginSlug.startsWith('theme:')) {
        const themeSlug = pluginSlug.replace('theme:', '');
        const themeDir = path.join(THEMES_DIR, themeSlug);
        if (resolvedPath.startsWith(themeDir)) {
            return true;
        }
    }

    return false;
}

/**
 * Create a security error with detailed message
 */
function createSecurityError(pluginSlug, action, details = '') {
    const msg = `🛡️ RUNTIME SECURITY BLOCK: Plugin '${pluginSlug}' attempted unauthorized action: ${action}${details ? ` (${details})` : ''}. Add the required permission to manifest.json.`;
    console.error(msg);
    return new Error(msg);
}

// ============================================
// FS Proxy
// ============================================

/**
 * Create a proxied version of the fs module that checks permissions
 */
function createSecureFs() {
    const handler = {
        get(target, prop) {
            const originalMethod = target[prop];

            // If it's not a function, return as-is
            if (typeof originalMethod !== 'function') {
                return originalMethod;
            }

            const pluginSlug = getCurrentPlugin();

            // Core code (no plugin context) has full access
            if (!pluginSlug) {
                return originalMethod;
            }

            // Check if this is a read method
            if (FS_READ_METHODS.includes(prop)) {
                return function (...args) {
                    const targetPath = args[0];

                    // Allow access to own plugin directory without explicit permission
                    if (isPathWithinPluginDir(pluginSlug, targetPath)) {
                        return originalMethod.apply(target, args);
                    }

                    // Check filesystem:read permission
                    if (!hasPermission('filesystem', 'read')) {
                        throw createSecurityError(pluginSlug, `fs.${prop}`, targetPath);
                    }

                    return originalMethod.apply(target, args);
                };
            }

            // Check if this is a write method
            if (FS_WRITE_METHODS.includes(prop)) {
                return function (...args) {
                    const targetPath = args[0];

                    // Allow write to own plugin directory without explicit permission
                    if (isPathWithinPluginDir(pluginSlug, targetPath)) {
                        return originalMethod.apply(target, args);
                    }

                    // Check filesystem:write permission
                    if (!hasPermission('filesystem', 'write')) {
                        throw createSecurityError(pluginSlug, `fs.${prop}`, targetPath);
                    }

                    return originalMethod.apply(target, args);
                };
            }

            // For other methods, return as-is (bound to target)
            return originalMethod.bind(target);
        }
    };

    return new Proxy(originalFs, handler);
}

// ============================================
// Child Process Proxy (Always Blocked for Plugins)
// ============================================

/**
 * Create a proxied version of child_process that ALWAYS blocks plugin access
 */
function createSecureChildProcess() {
    const handler = {
        get(target, prop) {
            const originalMethod = target[prop];

            // If it's not a function, return as-is
            if (typeof originalMethod !== 'function') {
                return originalMethod;
            }

            const pluginSlug = getCurrentPlugin();

            // Core code (no plugin context) has full access
            if (!pluginSlug) {
                return originalMethod;
            }

            // Check if this is a blocked method
            if (CHILD_PROCESS_BLOCKED.includes(prop)) {
                return function (...args) {
                    // Only allow if plugin has explicit 'system:admin' permission
                    if (hasPermission('system', 'admin')) {
                        console.warn(`⚠️ Plugin '${pluginSlug}' executing shell command with SYSTEM permission: ${prop}`);
                        return originalMethod.apply(target, args);
                    }

                    throw createSecurityError(
                        pluginSlug,
                        `child_process.${prop}`,
                        'Shell execution is blocked for plugins. Request system:admin permission if absolutely necessary.'
                    );
                };
            }

            // For other methods, return as-is
            return originalMethod.bind(target);
        }
    };

    return new Proxy(originalChildProcess, handler);
}

// ============================================
// Module Cache Interception
// ============================================

const secureFs = createSecureFs();
const secureChildProcess = createSecureChildProcess();

// Store original require
const Module = require('module');
const originalRequire = Module.prototype.require;

/**
 * Install the secure require hook
 * This intercepts require() calls and returns secure versions of sensitive modules
 */
function installSecureRequire() {
    Module.prototype.require = function (id) {
        const pluginSlug = getCurrentPlugin();

        // Only intercept for plugins
        if (pluginSlug) {
            // Return secure versions of sensitive modules
            if (id === 'fs') {
                return secureFs;
            }
            if (id === 'child_process') {
                return secureChildProcess;
            }
            if (id === 'fs/promises') {
                // Also protect fs/promises
                return createSecureFsPromises();
            }
        }

        // For everything else, use original require
        return originalRequire.apply(this, arguments);
    };

    console.log('🛡️ Secure Require: Runtime security hooks installed for fs and child_process');
}

/**
 * Create secure version of fs/promises
 */
function createSecureFsPromises() {
    const originalFsPromises = require('fs').promises;

    const handler = {
        get(target, prop) {
            const originalMethod = target[prop];

            if (typeof originalMethod !== 'function') {
                return originalMethod;
            }

            const pluginSlug = getCurrentPlugin();

            if (!pluginSlug) {
                return originalMethod;
            }

            // Determine if read or write
            const isRead = FS_READ_METHODS.includes(prop);
            const isWrite = FS_WRITE_METHODS.includes(prop);

            if (isRead || isWrite) {
                return async function (...args) {
                    const targetPath = args[0];

                    if (isPathWithinPluginDir(pluginSlug, targetPath)) {
                        return originalMethod.apply(target, args);
                    }

                    const permission = isWrite ? 'write' : 'read';
                    if (!hasPermission('filesystem', permission)) {
                        throw createSecurityError(pluginSlug, `fs.promises.${prop}`, targetPath);
                    }

                    return originalMethod.apply(target, args);
                };
            }

            return originalMethod.bind(target);
        }
    };

    return new Proxy(originalFsPromises, handler);
}

// ============================================
// Exports
// ============================================

module.exports = {
    installSecureRequire,
    createSecureFs,
    createSecureChildProcess,
    // Export for testing
    secureFs,
    secureChildProcess
};
