"use client";

import React from 'react';

type HookCallback = (data: any) => React.ReactNode | void;
type FilterCallback = (value: any, data: any) => any;

class PluginHooks {
    private actions: Map<string, { callback: HookCallback; priority: number }[]> = new Map();
    private filters: Map<string, { callback: FilterCallback; priority: number }[]> = new Map();
    private listeners: Set<() => void> = new Set();

    addAction(hook: string, callback: HookCallback, priority: number = 10) {
        if (!this.actions.has(hook)) {
            this.actions.set(hook, []);
        }
        this.actions.get(hook)?.push({ callback, priority });
        this.actions.get(hook)?.sort((a, b) => a.priority - b.priority);
        this.notify();
    }

    addFilter(hook: string, callback: FilterCallback, priority: number = 10) {
        if (!this.filters.has(hook)) {
            this.filters.set(hook, []);
        }
        this.filters.get(hook)?.push({ callback, priority });
        this.filters.get(hook)?.sort((a, b) => a.priority - b.priority);
        this.notify();
    }

    renderAction(hook: string, data: any): React.ReactNode[] {
        if (!this.actions.has(hook)) return [];
        return (this.actions.get(hook) || []).map((h, i) => (
            <React.Fragment key={`${hook}_${i}`}>
                {h.callback(data) as React.ReactNode}
            </React.Fragment>
        ));
    }

    applyFilters(hook: string, value: any, data: any): any {
        if (!this.filters.has(hook)) return value;
        let result = value;
        for (const { callback } of this.filters.get(hook) || []) {
            result = callback(result, data);
        }
        return result;
    }

    // Reactivity
    subscribe(callback: () => void) {
        this.listeners.add(callback);
        return () => { this.listeners.delete(callback); };
    }

    notify() {
        this.listeners.forEach(cb => cb());
    }
}

export const pluginHooks = new PluginHooks();

export function PluginHook({ name, data }: { name: string; data: any }) {
    const [, setTick] = React.useState(0);
    React.useEffect(() => pluginHooks.subscribe(() => setTick(t => t + 1)), []);

    return <>{pluginHooks.renderAction(name, data)}</>;
}
