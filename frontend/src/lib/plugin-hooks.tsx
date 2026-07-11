"use client";

import React from 'react';

type HookCallback = (data: any) => React.ReactNode | void;
type FilterCallback = (value: any, data: any) => any;

class PluginHooks {
    private actions: Map<string, { callback: HookCallback; priority: number; key?: string }[]> = new Map();
    private filters: Map<string, { callback: FilterCallback; priority: number; key?: string }[]> = new Map();
    private listeners: Set<() => void> = new Set();

    // `key` makes registration idempotent: re-registering the same key REPLACES the prior entry instead of
    // appending. Anonymous callbacks can't be de-duped by identity (each render creates a fresh closure), so
    // a re-run of a plugin's register() would otherwise stack duplicate UI. Callers without a key keep the
    // old append behavior for backward compatibility.
    addAction(hook: string, callback: HookCallback, priority: number = 10, key?: string) {
        if (!this.actions.has(hook)) {
            this.actions.set(hook, []);
        }
        const arr = this.actions.get(hook)!;
        const existing = key ? arr.findIndex(h => h.key === key) : -1;
        if (existing >= 0) {
            arr[existing] = { callback, priority, key };
        } else {
            arr.push({ callback, priority, key });
        }
        arr.sort((a, b) => a.priority - b.priority);
        this.notify();
    }

    addFilter(hook: string, callback: FilterCallback, priority: number = 10, key?: string) {
        if (!this.filters.has(hook)) {
            this.filters.set(hook, []);
        }
        const arr = this.filters.get(hook)!;
        const existing = key ? arr.findIndex(h => h.key === key) : -1;
        if (existing >= 0) {
            arr[existing] = { callback, priority, key };
        } else {
            arr.push({ callback, priority, key });
        }
        arr.sort((a, b) => a.priority - b.priority);
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
