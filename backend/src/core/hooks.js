/**
 * WordJS - Hook System
 * Equivalent to wp-includes/plugin.php (actions and filters)
 */

const EventEmitter = require('events');

class Hooks {
    constructor() {
        this.actions = new Map();
        this.filters = new Map();
        this.monitor = new EventEmitter();
        this.monitoringActive = 0; // Reference count
    }

    enableMonitoring() {
        this.monitoringActive++;
    }

    disableMonitoring() {
        if (this.monitoringActive > 0) this.monitoringActive--;
    }

    _emitMonitor(type, hook, args) {
        if (this.monitoringActive > 0) {
            // Light cloning to avoid reference issues in async transmission
            // simplistic serialize for now to avoid circular json errors
            const safeArgs = args.map(a => {
                try {
                    const type = typeof a;
                    if (type === 'object' && a !== null) {
                        return Array.isArray(a) ? `Array(${a.length})` : `Object(${a.constructor.name})`;
                    }
                    return a;
                } catch (e) { return '[Circular/Unsafe]'; }
            });

            this.monitor.emit('hook:call', {
                timestamp: Date.now(),
                type,
                hook,
                args: safeArgs
            });
        }
    }

    /**
     * Add an action hook
     * Equivalent to add_action()
     * @param {string} hook - Hook name
     * @param {Function} callback - Callback function
     * @param {number} priority - Priority (lower = earlier)
     */
    addAction(hook, callback, priority = 10) {
        const { getCurrentPlugin } = require('./plugin-context');
        const pluginSlug = getCurrentPlugin();

        if (!this.actions.has(hook)) {
            this.actions.set(hook, []);
        }
        this.actions.get(hook).push({ callback, priority, pluginSlug });
        this.actions.get(hook).sort((a, b) => a.priority - b.priority);
    }

    /**
     * Remove an action hook
     * Equivalent to remove_action()
     */
    removeAction(hook, callback) {
        if (!this.actions.has(hook)) return;
        const hooks = this.actions.get(hook);
        const index = hooks.findIndex(h => h.callback === callback);
        if (index > -1) hooks.splice(index, 1);
    }

    /**
     * Execute an action hook
     * Equivalent to do_action()
     */
    async doAction(hook, ...args) {
        this._emitMonitor('action', hook, args);
        if (!this.actions.has(hook)) return;
        const { runWithContext } = require('./plugin-context');
        for (const { callback, pluginSlug } of this.actions.get(hook)) {
            if (pluginSlug) {
                await runWithContext(pluginSlug, () => callback(...args));
            } else {
                await callback(...args);
            }
        }
    }

    /**
     * Execute an action hook synchronously
     */
    doActionSync(hook, ...args) {
        this._emitMonitor('action', hook, args);
        if (!this.actions.has(hook)) return;
        for (const { callback } of this.actions.get(hook)) {
            callback(...args);
        }
    }

    /**
     * Check if action exists
     * Equivalent to has_action()
     */
    hasAction(hook) {
        return this.actions.has(hook) && this.actions.get(hook).length > 0;
    }

    /**
     * Add a filter hook
     * Equivalent to add_filter()
     */
    addFilter(hook, callback, priority = 10) {
        const { getCurrentPlugin } = require('./plugin-context');
        const pluginSlug = getCurrentPlugin();

        if (!this.filters.has(hook)) {
            this.filters.set(hook, []);
        }
        this.filters.get(hook).push({ callback, priority, pluginSlug });
        this.filters.get(hook).sort((a, b) => a.priority - b.priority);
    }

    /**
     * Remove a filter hook
     * Equivalent to remove_filter()
     */
    removeFilter(hook, callback) {
        if (!this.filters.has(hook)) return;
        const hooks = this.filters.get(hook);
        const index = hooks.findIndex(h => h.callback === callback);
        if (index > -1) hooks.splice(index, 1);
    }

    /**
     * Apply filters to a value
     * Equivalent to apply_filters()
     */
    async applyFilters(hook, value, ...args) {
        this._emitMonitor('filter', hook, [value, ...args]);
        if (!this.filters.has(hook)) return value;
        const { runWithContext } = require('./plugin-context');
        let result = value;
        for (const { callback, pluginSlug } of this.filters.get(hook)) {
            if (pluginSlug) {
                result = await runWithContext(pluginSlug, () => callback(result, ...args));
            } else {
                result = await callback(result, ...args);
            }
        }
        return result;
    }

    /**
     * Apply filters synchronously
     */
    applyFiltersSync(hook, value, ...args) {
        this._emitMonitor('filter', hook, [value, ...args]);
        if (!this.filters.has(hook)) return value;
        let result = value;
        for (const { callback } of this.filters.get(hook)) {
            result = callback(result, ...args);
        }
        return result;
    }

    /**
     * Check if filter exists
     * Equivalent to has_filter()
     */
    hasFilter(hook) {
        return this.filters.has(hook) && this.filters.get(hook).length > 0;
    }

    /**
     * Get number of times action has been fired
     * Equivalent to did_action() - simplified version
     */
    getActionCount(hook) {
        return this.actions.has(hook) ? this.actions.get(hook).length : 0;
    }
    /**
     * Get all registered hooks (Actions and Filters)
     * For debugging/admin registry
     */
    getHooks() {
        const serializeHooks = (map) => {
            const result = {};
            for (const [hookName, handlers] of map.entries()) {
                result[hookName] = handlers.map(h => {
                    let fnName = h.callback.name;
                    if (!fnName || fnName === 'anonymous') {
                        // Extract preview of anonymous function
                        const source = h.callback.toString()
                            .replace(/\s+/g, ' ') // Collapse whitespace
                            .substring(0, 60);    // Truncate
                        fnName = `Anonymous: ${source}${source.length >= 60 ? '...' : ''}`;
                    }
                    return {
                        priority: h.priority,
                        pluginSlug: h.pluginSlug || 'core',
                        callback: fnName
                    };
                });
            }
            return result;
        };

        return {
            actions: serializeHooks(this.actions),
            filters: serializeHooks(this.filters)
        };
    }
}

// Global hooks instance
const hooks = new Hooks();

// Export convenience functions like WordPress
module.exports = {
    hooks,
    addAction: (hook, callback, priority) => hooks.addAction(hook, callback, priority),
    removeAction: (hook, callback) => hooks.removeAction(hook, callback),
    doAction: (hook, ...args) => hooks.doAction(hook, ...args),
    doActionSync: (hook, ...args) => hooks.doActionSync(hook, ...args),
    hasAction: (hook) => hooks.hasAction(hook),
    addFilter: (hook, callback, priority) => hooks.addFilter(hook, callback, priority),
    removeFilter: (hook, callback) => hooks.removeFilter(hook, callback),
    applyFilters: (hook, value, ...args) => hooks.applyFilters(hook, value, ...args),
    applyFiltersSync: (hook, value, ...args) => hooks.applyFiltersSync(hook, value, ...args),
    hasFilter: (hook) => hooks.hasFilter(hook)
};
