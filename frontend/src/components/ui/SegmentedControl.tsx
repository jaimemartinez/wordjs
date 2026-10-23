"use client";

import React, { useRef } from "react";

export interface SegmentOption<V extends string = string> {
    value: V;
    label: React.ReactNode;
    icon?: string;
    disabled?: boolean;
    /** Needed when the label is only an icon. */
    "aria-label"?: string;
}

export interface SegmentedControlProps<V extends string = string> {
    options: SegmentOption<V>[];
    value: V;
    onChange: (value: V) => void;
    /** The group's name for assistive tech. */
    "aria-label": string;
    size?: "sm" | "md";
    disabled?: boolean;
    className?: string;
}

/**
 * SegmentedControl — one choice among a few, shown side by side (view: grid / list; device: desktop /
 * tablet / phone). A radiogroup with one tab stop: arrow keys move and choose, like native radios.
 */
export function SegmentedControl<V extends string = string>({ options, value, onChange, size = "md", disabled, className = "", ...rest }: SegmentedControlProps<V>) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const enabled = options.map((o, i) => (o.disabled || disabled ? -1 : i)).filter((i) => i >= 0);
    const move = (from: number, dir: 1 | -1) => {
        if (!enabled.length) return;
        const pos = enabled.indexOf(from);
        const next = enabled[(pos + dir + enabled.length) % enabled.length];
        onChange(options[next].value);
        refs.current[next]?.focus();
    };
    const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm";
    return (
        <div role="radiogroup" aria-label={rest["aria-label"]} className={`inline-flex rounded-xl bg-gray-100 p-1 gap-1 ${className}`}>
            {options.map((o, i) => {
                const on = o.value === value;
                return (
                    <button
                        key={o.value}
                        ref={(el) => { refs.current[i] = el; }}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={o["aria-label"]}
                        tabIndex={on || (!options.some((x) => x.value === value) && i === enabled[0]) ? 0 : -1}
                        disabled={o.disabled || disabled}
                        onClick={() => onChange(o.value)}
                        onKeyDown={(e) => {
                            if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i, 1); }
                            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i, -1); }
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg font-semibold transition-colors ${pad} pointer-coarse:min-h-11 ` +
                            `focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 disabled:opacity-50 disabled:cursor-not-allowed ` +
                            (on ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900")}
                    >
                        {o.icon && <i className={`fa-solid ${o.icon}`} aria-hidden="true"></i>}
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

export default SegmentedControl;
