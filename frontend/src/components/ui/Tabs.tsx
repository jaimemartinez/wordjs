"use client";

import React, { useId, useRef } from "react";

export interface TabItem<V extends string = string> {
    value: V;
    label: React.ReactNode;
    icon?: string;
    /** A count or badge after the label. */
    badge?: React.ReactNode;
    disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
    tabs: TabItem<V>[];
    value: V;
    onChange: (value: V) => void;
    /** The tab list's name for assistive tech. */
    "aria-label": string;
    /** The selected tab's panel. Rendered with role="tabpanel", labelled by its tab. */
    children?: React.ReactNode;
    className?: string;
    listClassName?: string;
}

/**
 * Tabs — a WAI-ARIA tab list (one tab stop, arrows / Home / End move and select) and the selected tab's
 * panel. A screen that draws the panel itself omits `children`.
 */
export function Tabs<V extends string = string>({ tabs, value, onChange, children, className = "", listClassName = "", ...rest }: TabsProps<V>) {
    const base = useId().replace(/:/g, "");
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const enabled = tabs.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);
    const go = (index: number) => { onChange(tabs[index].value); refs.current[index]?.focus(); };
    const onKey = (e: React.KeyboardEvent, i: number) => {
        const pos = enabled.indexOf(i);
        let next: number | undefined;
        if (e.key === "ArrowRight") next = enabled[(pos + 1) % enabled.length];
        else if (e.key === "ArrowLeft") next = enabled[(pos - 1 + enabled.length) % enabled.length];
        else if (e.key === "Home") next = enabled[0];
        else if (e.key === "End") next = enabled[enabled.length - 1];
        if (next !== undefined) { e.preventDefault(); go(next); }
    };
    const selected = tabs.findIndex((t) => t.value === value);
    return (
        <div className={className}>
            <div role="tablist" aria-label={rest["aria-label"]} className={`flex gap-1 overflow-x-auto border-b border-gray-200 ${listClassName}`}>
                {tabs.map((t, i) => {
                    const on = i === selected;
                    return (
                        <button
                            key={t.value}
                            ref={(el) => { refs.current[i] = el; }}
                            id={`${base}-tab-${t.value}`}
                            type="button"
                            role="tab"
                            aria-selected={on}
                            aria-controls={`${base}-panel-${t.value}`}
                            tabIndex={on || (selected < 0 && i === enabled[0]) ? 0 : -1}
                            disabled={t.disabled}
                            onClick={() => onChange(t.value)}
                            onKeyDown={(e) => onKey(e, i)}
                            className={`inline-flex items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors pointer-coarse:min-h-11 ` +
                                `focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50 disabled:cursor-not-allowed ` +
                                (on ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300")}
                        >
                            {t.icon && <i className={`fa-solid ${t.icon}`} aria-hidden="true"></i>}
                            {t.label}
                            {t.badge !== undefined && t.badge !== null && (
                                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-700">{t.badge}</span>
                            )}
                        </button>
                    );
                })}
            </div>
            {children !== undefined && selected >= 0 && (
                <div role="tabpanel" id={`${base}-panel-${value}`} aria-labelledby={`${base}-tab-${value}`} tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-blue-500">
                    {children}
                </div>
            )}
        </div>
    );
}

export default Tabs;
