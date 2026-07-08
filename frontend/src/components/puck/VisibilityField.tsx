"use client";

import React from "react";
import { AnimSpec, AnimationControl, animClasses, useEntranceAnimation } from "./AnimationField";

/**
 * Per-block responsive visibility (Webflow-style "hide on device"). The field stores
 * `{ mobile?: boolean; tablet?: boolean; desktop?: boolean }` (true = hidden) and the block is
 * wrapped in a `display: contents` element carrying `wjs-hide-*` classes, so hiding is pure CSS
 * media queries — it works identically on the SSR public site and inside the editor's device
 * preview (switching the editor viewport shows exactly what that device shows).
 *
 * Breakpoints match the editor viewports and the Columns stack point:
 * mobile <768px, tablet 768–1023px, desktop ≥1024px (rules live in wordjs-ui.css).
 */

export type Hide = { mobile?: boolean; tablet?: boolean; desktop?: boolean };

export const hideClasses = (hide?: Hide): string =>
    [hide?.mobile && "wjs-hide-mobile", hide?.tablet && "wjs-hide-tablet", hide?.desktop && "wjs-hide-desktop"]
        .filter(Boolean)
        .join(" ");

const DEVICES: { key: keyof Hide; icon: string; label: string }[] = [
    { key: "mobile", icon: "fa-mobile-screen-button", label: "Móvil" },
    { key: "tablet", icon: "fa-tablet-screen-button", label: "Tablet" },
    { key: "desktop", icon: "fa-desktop", label: "Escritorio" },
];

export function VisibilityControl({ value, onChange }: { value: Hide; onChange: (v: Hide) => void }) {
    const hide = value || {};
    return (
        <div>
            <div className="flex gap-1.5">
                {DEVICES.map((d) => {
                    const hidden = !!hide[d.key];
                    return (
                        <button
                            key={d.key}
                            type="button"
                            title={hidden ? `Oculto en ${d.label} — clic para mostrar` : `Visible en ${d.label} — clic para ocultar`}
                            onClick={() => onChange({ ...hide, [d.key]: !hidden })}
                            className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-lg border text-[10px] font-semibold transition ${
                                hidden
                                    ? "bg-red-50 border-red-200 text-red-500"
                                    : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                            }`}
                        >
                            <span className="relative inline-flex items-center justify-center w-5 h-5">
                                <i className={`fa-solid ${d.icon} text-sm`}></i>
                                {hidden && <i className="fa-solid fa-slash absolute text-sm"></i>}
                            </span>
                            {d.label}
                        </button>
                    );
                })}
            </div>
            <p className="text-[10px] text-gray-400 mt-1.5">
                Los bloques ocultos desaparecen también en la vista previa del dispositivo del editor.
            </p>
        </div>
    );
}

/**
 * Wrap every component in a config so it gains the shared block fields — `hide` (per-device
 * visibility) and `anim` (entrance animation) — plus the single wrapper element that carries both.
 * Applied once at config build time (module scope) so each wrapped render is a stable component
 * and inner hooks stay valid. Blocks that already define `hide` are left untouched.
 *
 * Wrapper box model: `display: contents` normally (zero layout impact), but an ANIMATED block
 * needs a real box — transform/opacity do nothing on a contents element — so it becomes a plain
 * block-level div that simply takes the block's place in flow/grid/flex. The `wjs-hide-*` media
 * queries use !important, so device-hiding still wins over the block display.
 */
export function withSharedBlockFields(components: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [name, def] of Object.entries(components || {})) {
        if (!def?.render || def.fields?.hide) {
            out[name] = def;
            continue;
        }
        const Inner = def.render;
        const Wrapped = (props: any) => {
            const hideCls = hideClasses(props.hide);
            const anim = (props.anim || {}) as AnimSpec;
            // Never animate inside the editor canvas — authoring must stay still (preview shows it).
            const animActive = !!anim.type && !props.puck?.isEditing;
            const ref = React.useRef<HTMLDivElement>(null);
            useEntranceAnimation(ref, animActive ? anim : null);
            const inner = <Inner {...props} />;
            if (!hideCls && !animActive) return inner;
            return (
                <div
                    ref={ref}
                    className={[hideCls, animActive ? animClasses(anim) : ""].filter(Boolean).join(" ")}
                    style={
                        animActive
                            ? ({
                                  // Clamp defensively: sanitize-meta passes numbers through untouched,
                                  // so hostile _puck_data (API/WXR import) could set a multi-hour delay
                                  // and keep the block invisible. The UI caps at 600ms; 3s is the hard
                                  // ceiling for any data source.
                                  "--wjs-anim-dur": `${Math.min(Math.max(Number(anim.duration) || 600, 100), 3000)}ms`,
                                  "--wjs-anim-delay": `${Math.min(Math.max(Number(anim.delay) || 0, 0), 3000)}ms`,
                              } as React.CSSProperties)
                            : { display: "contents" }
                    }
                >
                    {inner}
                </div>
            );
        };
        Wrapped.displayName = `WithSharedBlockFields(${name})`;
        out[name] = {
            ...def,
            fields: {
                ...def.fields,
                hide: {
                    type: "custom",
                    label: "Visibilidad por dispositivo",
                    render: ({ value, onChange }: any) => <VisibilityControl value={value} onChange={onChange} />,
                },
                anim: {
                    type: "custom",
                    label: "Animación de entrada",
                    render: ({ value, onChange }: any) => <AnimationControl value={value} onChange={onChange} />,
                },
            },
            defaultProps: { ...(def.defaultProps || {}), hide: {}, anim: {} },
            render: Wrapped,
        };
    }
    return out;
}
