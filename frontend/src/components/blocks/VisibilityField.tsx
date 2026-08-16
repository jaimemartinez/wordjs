"use client";

import React from "react";
import MSym from "../editor/MSym";
import { AnimSpec, AnimationControl, animClasses, useEntranceAnimation } from "./AnimationField";
import { Appearance, AppearanceControl, appearanceToStyle } from "./AppearanceField";

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

// Hide + hideClasses live in blockShell.ts (pure, server-safe) — re-exported here.
import { hideClasses } from "./blockShell";
import type { Hide } from "./blockShell";
export { hideClasses };
export type { Hide };

const DEVICES: { key: keyof Hide; icon: string; label: string }[] = [
    { key: "mobile", icon: "smartphone", label: "Móvil" },
    { key: "tablet", icon: "tablet_mac", label: "Tablet" },
    { key: "desktop", icon: "desktop_windows", label: "Escritorio" },
];

export function VisibilityControl({ value, onChange }: { value: Hide; onChange: (v: Hide) => void }) {
    const hide = value || {};
    return (
        // wjs-f-hide — marker for the properties panel's AVANZADO tab filter (see editor-theme.css).
        <div className="wjs-f-hide">
            <div className="flex gap-0.5 bg-[var(--ed-surface-container-high)] p-0.5 rounded border border-[var(--ed-outline-variant)]">
                {DEVICES.map((d) => {
                    const hidden = !!hide[d.key];
                    return (
                        <button
                            key={d.key}
                            type="button"
                            title={hidden ? `Oculto en ${d.label} — clic para mostrar` : `Visible en ${d.label} — clic para ocultar`}
                            onClick={() => onChange({ ...hide, [d.key]: !hidden })}
                            className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded text-[10px] font-medium transition ${
                                hidden
                                    ? "bg-[var(--ed-primary)] text-white shadow-sm"
                                    : "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                            }`}
                        >
                            <MSym name={hidden ? "visibility_off" : d.icon} size={16} />
                            {d.label}
                        </button>
                    );
                })}
            </div>
            <p className="text-[10px] text-[var(--ed-outline)] mt-1.5">
                Los bloques ocultos desaparecen también en la vista previa del dispositivo del editor.
            </p>
        </div>
    );
}

/**
 * Wrap every component in a config so it gains the shared block fields — `hide` (per-device
 * visibility), `anim` (entrance animation) and `look` (the full Appearance system: background,
 * border, shadow, spacing, typography, hover motion) — plus the single wrapper element that
 * carries all three. Applied once at config build time (module scope) so each wrapped render is a
 * stable component and inner hooks stay valid. Blocks that already define `hide` are left alone.
 *
 * This is the single highest-leverage seam in the editor: it is why every block — core AND
 * marketplace-plugin blocks, which are compiled elsewhere and merged in at runtime — is fully
 * restyleable from the properties panel without each block re-implementing colour/spacing fields.
 *
 * Wrapper box model: `display: contents` normally (zero layout impact), but an ANIMATED or STYLED
 * block needs a real box — transform/opacity/background do nothing on a contents element — so it
 * becomes a plain block-level div that simply takes the block's place in flow/grid/flex. The
 * `wjs-hide-*` media queries use !important, so device-hiding still wins over the block display.
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
            const animActive = !!anim.type;
            // Scroll-driven effects need the wrapper (and a REAL box) even with entrance "Ninguna" —
            // animClasses emits both families, but a display:contents element can't animate.
            const scrollActive = !!anim.scroll;
            const wrapActive = animActive || scrollActive;
            const look = appearanceToStyle(props.look as Appearance);
            const ref = React.useRef<HTMLDivElement>(null);
            useEntranceAnimation(ref, animActive ? anim : null);
            const inner = <Inner {...props} />;
            // Untouched block → no wrapper element at all, so its own render() is untouched.
            if (!hideCls && !animActive && !look.hasBox) return inner;

            // TWO NESTED LAYERS, deliberately — they must never share an element.
            // The entrance animation owns `animation` and `transform` on the OUTER element; the
            // appearance box owns `animation` (moving gradient) and `transform` (hover) on the
            // INNER one. On a single element they collide: a running/filled animation beats a
            // plain `:hover` declaration in the cascade, so `animation-fill-mode: both` would pin
            // `transform: none` after the entrance and silently kill every hover effect — and the
            // moving gradient and the entrance effect would fight over one `animation-name`.
            const box = look.hasBox ? (
                <div className={look.className || undefined} style={look.style}>
                    {look.overlay && <div style={look.overlay} aria-hidden="true" />}
                    {/* The overlay is absolutely positioned over the box, so the block's own content
                        needs its own stacking context to stay above it. */}
                    {look.overlay ? <div style={{ position: "relative" }}>{inner}</div> : inner}
                </div>
            ) : (
                inner
            );

            if (!hideCls && !wrapActive) return box;

            return (
                <div
                    ref={ref}
                    className={[hideCls, wrapActive ? animClasses(anim) : ""].filter(Boolean).join(" ")}
                    style={
                        animActive || scrollActive
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
                    {box}
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
                look: {
                    type: "custom",
                    label: "Apariencia",
                    render: ({ value, onChange }: any) => <AppearanceControl value={value} onChange={onChange} />,
                },
            },
            // New blocks arrive with a subtle entrance already on: a page built by dropping blocks
            // should feel alive without the author hunting for the setting. It is one dropdown away
            // from "Ninguna", and reduced-motion users never see it.
            defaultProps: {
                ...(def.defaultProps || {}),
                hide: {},
                anim: { type: "fade-up", duration: 600, delay: 0 },
                look: {},
            },
            render: Wrapped,
        };
    }
    return out;
}

