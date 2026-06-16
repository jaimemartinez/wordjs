/**
 * WordJS - App Registry
 * Provides a way for plugins to access the Express app instance
 * for dynamic route registration.
 *
 * SECURITY (ALS-anchoring): when a plugin registers an Express route/middleware, the handler
 * runs LATER, on an HTTP request, with an empty AsyncLocalStorage context — which previously
 * made the sandbox fall back to a spoofable call-stack scan. We patch the app's routing methods
 * so that any handler registered WHILE a plugin is the effective plugin is wrapped to re-enter
 * that plugin's context (runWithContext) on every invocation. This makes the ALS context the
 * AUTHORITATIVE signal for plugin route handlers (and the timers/promises they spawn, since ALS
 * propagates into them); the stack scan remains only as defense-in-depth.
 */

let appInstance = null;

const ROUTE_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all', 'use'];

function wrapHandler(slug, fn) {
    if (typeof fn !== 'function') return fn;
    const { runWithContext } = require('./plugin-context');
    const wrapped = function (...args) {
        return runWithContext(slug, () => fn.apply(this, args));
    };
    // Preserve arity so Express still detects 4-arg error-handling middleware.
    try {
        Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true });
    } catch { /* non-fatal */ }
    return wrapped;
}

/**
 * Patch the app's routing methods so plugin-registered handlers run inside the plugin context.
 * Core registrations (no effective plugin at registration time) are left untouched.
 */
function anchorPluginRoutes(app) {
    if (!app || app.__wordjsAnchored) return;
    const { getEffectivePlugin } = require('./plugin-context');

    for (const method of ROUTE_METHODS) {
        const original = app[method];
        if (typeof original !== 'function') continue;

        app[method] = function (...args) {
            const slug = getEffectivePlugin();
            if (slug) {
                // Wrap every handler/middleware function argument; leave paths/options as-is.
                args = args.map(a => (typeof a === 'function' ? wrapHandler(slug, a) : a));
            }
            return original.apply(this, args);
        };
    }

    try {
        Object.defineProperty(app, '__wordjsAnchored', { value: true, enumerable: false });
    } catch { /* non-fatal */ }
}

module.exports = {
    /**
     * Set the Express app instance (called from index.js)
     */
    setApp(app) {
        appInstance = app;
        anchorPluginRoutes(app);
    },

    /**
     * Get the Express app instance
     * @returns {import('express').Express | null}
     */
    getApp() {
        return appInstance;
    },

    // Exported for testing.
    anchorPluginRoutes
};
