"use client";

import React from "react";

/**
 * Per-block entrance animation (Webflow-style "scroll reveal"). The field stores
 * `{ type, duration, delay }`; the shared block wrapper (VisibilityField.withSharedBlockFields)
 * renders the classes and arms the IntersectionObserver.
 *
 * Safety model — the block is NEVER hidden by the server-rendered HTML:
 *  - The SSR markup ships fully visible; only live JS sets data-wjs-anim="armed" (opacity 0) right
 *    before observing, so no-JS visitors and crawlers always see content.
 *  - `prefers-reduced-motion: reduce` skips both the JS arming AND the CSS rules (belt + braces).
 *  - Inside the editor canvas (puck.isEditing) nothing animates — authors preview on the live site.
 * The JS-driven state lives in a data attribute, not className: React owns className and would
 * wipe classes added imperatively on any re-render; it never touches attributes it didn't render.
 */

export type AnimSpec = {
    type?: "" | "fade" | "fade-up" | "fade-left" | "fade-right" | "zoom";
    duration?: number;
    delay?: number;
};

export const animClasses = (anim?: AnimSpec): string =>
    anim?.type ? `wjs-anim wjs-anim-${anim.type}` : "";

export function useEntranceAnimation(ref: React.RefObject<HTMLDivElement | null>, anim: AnimSpec | null) {
    const type = anim?.type || "";
    React.useEffect(() => {
        const el = ref.current;
        if (!type || !el || typeof window === "undefined") return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        if (typeof IntersectionObserver === "undefined") return; // ancient browser → stay visible
        el.setAttribute("data-wjs-anim", "armed");
        // threshold MUST be 0 (first visible pixel) with no negative rootMargin: a ratio threshold
        // is geometrically unreachable for blocks taller than ~viewport/threshold (a tall Section,
        // or Columns stacked on mobile, maxes out at viewportH/blockH < 0.15) and a negative bottom
        // margin creates a dead strip where last-blocks on short pages never fire — both left the
        // block armed (opacity 0) FOREVER. Confirmed empirically in Chrome; do not "tune" these.
        const io = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        el.setAttribute("data-wjs-anim", "in");
                        io.disconnect();
                    }
                }
            },
            { threshold: 0 }
        );
        io.observe(el);
        return () => {
            io.disconnect();
            // If the block unmounts/re-keys mid-flight, never leave it armed-invisible.
            if (el.getAttribute("data-wjs-anim") === "armed") el.removeAttribute("data-wjs-anim");
        };
    }, [ref, type]);
}

const EFFECTS: { value: NonNullable<AnimSpec["type"]>; label: string }[] = [
    { value: "", label: "Ninguna" },
    { value: "fade", label: "Desvanecer" },
    { value: "fade-up", label: "Aparecer subiendo" },
    { value: "fade-left", label: "Desde la izquierda" },
    { value: "fade-right", label: "Desde la derecha" },
    { value: "zoom", label: "Zoom suave" },
];

const DURATIONS: { value: number; label: string }[] = [
    { value: 300, label: "Rápida" },
    { value: 600, label: "Normal" },
    { value: 900, label: "Lenta" },
];

const DELAYS = [0, 100, 200, 300, 450, 600];

export function AnimationControl({ value, onChange }: { value: AnimSpec; onChange: (v: AnimSpec) => void }) {
    const anim = value || {};
    const active = !!anim.type;
    return (
        <div>
            <select
                value={anim.type || ""}
                onChange={(e) => onChange({ ...anim, type: e.target.value as AnimSpec["type"] })}
                className="w-full p-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-editor-primary/30 focus:border-editor-primary"
            >
                {EFFECTS.map((e) => (
                    <option key={e.value} value={e.value}>{e.label}</option>
                ))}
            </select>
            {active && (
                <>
                    <div className="flex gap-1.5 mt-2">
                        {DURATIONS.map((d) => {
                            const selected = (anim.duration || 600) === d.value;
                            return (
                                <button
                                    key={d.value}
                                    type="button"
                                    onClick={() => onChange({ ...anim, duration: d.value })}
                                    className={`flex-1 py-1.5 rounded-lg border text-[11px] font-semibold transition ${
                                        selected
                                            ? "bg-editor-primary/10 border-editor-primary text-editor-primary"
                                            : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                                    }`}
                                >
                                    {d.label}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                        <label className="text-[11px] text-gray-500 shrink-0">Retardo</label>
                        <select
                            value={String(anim.delay || 0)}
                            onChange={(e) => onChange({ ...anim, delay: parseInt(e.target.value, 10) || 0 })}
                            className="flex-1 p-1.5 border border-gray-200 rounded-lg text-xs bg-white focus:outline-none"
                        >
                            {DELAYS.map((d) => (
                                <option key={d} value={d}>{d === 0 ? "Sin retardo" : `${d} ms`}</option>
                            ))}
                        </select>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1.5">
                        Se reproduce al entrar en pantalla en el sitio publicado. En el editor no se anima: usa Vista previa. Usa el retardo para escalonar bloques contiguos.
                    </p>
                </>
            )}
        </div>
    );
}
