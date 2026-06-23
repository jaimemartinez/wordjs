/**
 * WordJS - Hook System
 * Equivalent to wp-includes/plugin.php (actions and filters)
 */

const EventEmitter = require('events');

class Hooks {
    actions: Map<string, any[]>;
    filters: Map<string, any[]>;
    monitor: any;
    monitoringActive: number;

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

    _emitMonitor(type: string, hook: string, args: any[]) {
        if (this.monitoringActive > 0) {
            // Light cloning to avoid reference issues in async transmission
            // simplistic serialize for now to avoid circular json errors
            const safeArgs = args.map((a: any) => {
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
    addAction(hook: string, callback: any, priority: number = 10) {
        const { getCurrentPlugin } = require('./plugin-context');
        const pluginSlug = getCurrentPlugin();

        if (!this.actions.has(hook)) {
            this.actions.set(hook, []);
        }
        this.actions.get(hook)!.push({ callback, priority, pluginSlug });
        this.actions.get(hook)!.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Remove an action hook
     * Equivalent to remove_action()
     */
    removeAction(hook: string, callback: any) {
        if (!this.actions.has(hook)) return;
        const hooks = this.actions.get(hook)!;
        const index = hooks.findIndex(h => h.callback === callback);
        if (index > -1) hooks.splice(index, 1);
    }

    /**
     * Execute an action hook
     * Equivalent to do_action()
     */
    async doAction(hook: string, ...args: any[]) {
        this._emitMonitor('action', hook, args);
        if (!this.actions.has(hook)) return;
        const { runWithContext } = require('./plugin-context');
        for (const { callback, pluginSlug } of this.actions.get(hook)!) {
            if (pluginSlug) {
                await runWithContext(pluginSlug, () => callback(...args));
            } else {
                await callback(...args);
            }
        }
    }

    /**
     * Execute an action hook but ONLY invoke callbacks registered by a specific plugin, each in
     * that plugin's context. Used by cron so a plugin-scheduled event cannot trigger CORE hook
     * callbacks (with attacker-controlled args) — it only runs the scheduling plugin's own callbacks.
     */
    async doActionForPlugin(hook: string, slug: string, ...args: any[]) {
        this._emitMonitor('action', hook, args);
        if (!this.actions.has(hook)) return;
        const { runWithContext } = require('./plugin-context');
        for (const { callback, pluginSlug } of this.actions.get(hook)!) {
            if (pluginSlug !== slug) continue; // only the scheduling plugin's own callbacks
            await runWithContext(slug, () => callback(...args));
        }
    }

    /**
     * Execute an action hook synchronously
     */
    doActionSync(hook: string, ...args: any[]) {
        this._emitMonitor('action', hook, args);
        if (!this.actions.has(hook)) return;
        for (const { callback, pluginSlug } of this.actions.get(hook)!) {
            if (pluginSlug) {
                // A plugin callback registered with a pluginSlug is an ISOLATE shim: it dispatches to a
                // worker and returns a Promise. The sync path cannot await it, so running it here would
                // either silently drop the result or, worse, partially apply it. Skip with a warning —
                // callers needing plugin participation must use the async doAction().
                console.warn(`[Hooks] doActionSync('${hook}'): skipping isolate plugin callback for '${pluginSlug}' (async-only; use doAction).`);
                continue;
            }
            callback(...args);
        }
    }

    /**
     * Check if action exists
     * Equivalent to has_action()
     */
    hasAction(hook: string) {
        return this.actions.has(hook) && this.actions.get(hook)!.length > 0;
    }

    /**
     * Add a filter hook
     * Equivalent to add_filter()
     */
    addFilter(hook: string, callback: any, priority: number = 10) {
        const { getCurrentPlugin } = require('./plugin-context');
        const pluginSlug = getCurrentPlugin();

        if (!this.filters.has(hook)) {
            this.filters.set(hook, []);
        }
        this.filters.get(hook)!.push({ callback, priority, pluginSlug });
        this.filters.get(hook)!.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Remove a filter hook
     * Equivalent to remove_filter()
     */
    removeFilter(hook: string, callback: any) {
        if (!this.filters.has(hook)) return;
        const hooks = this.filters.get(hook)!;
        const index = hooks.findIndex(h => h.callback === callback);
        if (index > -1) hooks.splice(index, 1);
    }

    /**
     * Apply filters to a value
     * Equivalent to apply_filters()
     */
    async applyFilters(hook: string, value: any, ...args: any[]) {
        this._emitMonitor('filter', hook, [value, ...args]);
        if (!this.filters.has(hook)) return value;
        const { runWithContext } = require('./plugin-context');
        let result = value;
        for (const { callback, pluginSlug } of this.filters.get(hook)!) {
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
    applyFiltersSync(hook: string, value: any, ...args: any[]) {
        this._emitMonitor('filter', hook, [value, ...args]);
        if (!this.filters.has(hook)) return value;
        let result = value;
        for (const { callback, pluginSlug } of this.filters.get(hook)!) {
            if (pluginSlug) {
                // Isolate shim: returns a Promise the sync path can't await. Assigning it to `result`
                // would corrupt the value (a Promise, not the filtered value). Skip with a warning;
                // sync filters only honor core (non-plugin) callbacks. Use applyFilters() for plugins.
                console.warn(`[Hooks] applyFiltersSync('${hook}'): skipping isolate plugin callback for '${pluginSlug}' (async-only; use applyFilters).`);
                continue;
            }
            result = callback(result, ...args);
        }
        return result;
    }

    /**
     * Check if filter exists
     * Equivalent to has_filter()
     */
    hasFilter(hook: string) {
        return this.filters.has(hook) && this.filters.get(hook)!.length > 0;
    }

    /**
     * Get the number of callbacks currently registered for an action hook.
     * NOTE: this is the registered-handler count, NOT a "times fired" counter (no such counter exists).
     */
    getActionHandlerCount(hook: string) {
        return this.actions.has(hook) ? this.actions.get(hook)!.length : 0;
    }
    /**
     * Get all registered hooks (Actions and Filters)
     * For debugging/admin registry
     */
    getHooks() {
        const serializeHooks = (map: Map<string, any[]>) => {
            const result: Record<string, any> = {};
            for (const [hookName, handlers] of map.entries()) {
                result[hookName] = handlers.map((h: any) => {
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
    addAction: (hook: string, callback: any, priority?: number) => hooks.addAction(hook, callback, priority),
    removeAction: (hook: string, callback: any) => hooks.removeAction(hook, callback),
    doAction: (hook: string, ...args: any[]) => hooks.doAction(hook, ...args),
    doActionForPlugin: (hook: string, slug: string, ...args: any[]) => hooks.doActionForPlugin(hook, slug, ...args),
    doActionSync: (hook: string, ...args: any[]) => hooks.doActionSync(hook, ...args),
    hasAction: (hook: string) => hooks.hasAction(hook),
    addFilter: (hook: string, callback: any, priority?: number) => hooks.addFilter(hook, callback, priority),
    removeFilter: (hook: string, callback: any) => hooks.removeFilter(hook, callback),
    applyFilters: (hook: string, value: any, ...args: any[]) => hooks.applyFilters(hook, value, ...args),
    applyFiltersSync: (hook: string, value: any, ...args: any[]) => hooks.applyFiltersSync(hook, value, ...args),
    hasFilter: (hook: string) => hooks.hasFilter(hook)
};
