"use client";

import React from "react";
import MSym from "../editor/MSym";

/**
 * Per-block entrance animation (Webflow-style "scroll reveal"). The field stores
 * `{ type, duration, delay }`; the shared block wrapper (VisibilityField.withSharedBlockFields)
 * renders the classes and arms the IntersectionObserver.
 *
 * Safety model — the block is NEVER hidden by the server-rendered HTML:
 *  - The SSR markup ships fully visible; only live JS sets data-wjs-anim="armed" (opacity 0) right
 *    before observing, so no-JS visitors and crawlers always see content.
 *  - `prefers-reduced-motion: reduce` skips both the JS arming AND the CSS rules (belt + braces).
 *  - The editor canvas DOES animate, so authors judge the motion where they are working. It fires
 *    once per block on scroll-in (the observer disconnects), never on every re-render, so it can
 *    never flicker while typing; the toolbar's replay button re-arms everything on demand.
 * The JS-driven state lives in a data attribute, not className: React owns className and would
 * wipe classes added imperatively on any re-render; it never touches attributes it didn't render.
 */

// AnimSpec + animClasses live in blockShell.ts (pure, server-safe) — re-exported here so
// existing imports keep working. useEntranceAnimation below stays client-only.
import { animClasses } from "./blockShell";
import type { AnimSpec } from "./blockShell";
export { animClasses };
export type { AnimSpec };

/** Event that re-arms every animated block so the author can watch the sequence again. */
export const ANIM_REPLAY_EVENT = "wjs-anim-replay";

/**
 * Re-arm and replay every entrance animation in a document (the editor canvas iframe, normally).
 * Exposed as a plain DOM event so it crosses the iframe boundary without a React bridge: the
 * toolbar dispatches it into the canvas document and each armed block re-runs its own effect.
 */
export function replayAnimations(doc: Document) {
    doc.dispatchEvent(new CustomEvent(ANIM_REPLAY_EVENT));
}

export function useEntranceAnimation(ref: React.RefObject<HTMLDivElement | null>, anim: AnimSpec | null) {
    const type = anim?.type || "";
    React.useEffect(() => {
        const el = ref.current;
        if (!type || !el || typeof window === "undefined") return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        if (typeof IntersectionObserver === "undefined") return; // ancient browser → stay visible

        // Replay: strip the state, force a reflow so the browser cannot coalesce the attribute
        // removal and re-add into "no change" (which would skip the animation entirely), then
        // re-arm and let it run. Listening on the element's OWN document keeps this working inside
        // the canvas iframe, whose document is not the editor's.
        const onReplay = () => {
            el.removeAttribute("data-wjs-anim");
            void el.offsetWidth; // force reflow — do not remove
            el.setAttribute("data-wjs-anim", "in");
        };
        el.ownerDocument.addEventListener(ANIM_REPLAY_EVENT, onReplay);

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
            el.ownerDocument.removeEventListener(ANIM_REPLAY_EVENT, onReplay);
            // If the block unmounts/re-keys mid-flight, never leave it armed-invisible.
            if (el.getAttribute("data-wjs-anim") === "armed") el.removeAttribute("data-wjs-anim");
        };
    }, [ref, type]);
}

const EFFECTS: { value: NonNullable<AnimSpec["type"]>; label: string }[] = [
    { value: "", label: "Ninguna" },
    { value: "fade", label: "Desvanecer" },
    { value: "fade-up", label: "Aparecer subiendo" },
    { value: "fade-down", label: "Aparecer bajando" },
    { value: "fade-left", label: "Desde la izquierda" },
    { value: "fade-right", label: "Desde la derecha" },
    { value: "zoom", label: "Zoom suave" },
    { value: "zoom-out", label: "Zoom hacia atrás" },
    { value: "blur", label: "Enfocar (desenfoque)" },
    { value: "rise", label: "Ascenso lento" },
    { value: "flip", label: "Giro 3D" },
    { value: "reveal", label: "Revelado (cortinilla)" },
    { value: "swing", label: "Balanceo" },
];

const DURATIONS: { value: number; label: string }[] = [
    { value: 300, label: "Rápida" },
    { value: 600, label: "Normal" },
    { value: 900, label: "Lenta" },
];

const DELAYS = [0, 100, 200, 300, 450, 600];

const SCROLL_EFFECTS: { value: NonNullable<AnimSpec["scroll"]>; label: string }[] = [
    { value: "", label: "Ninguno" },
    { value: "parallax", label: "Parallax" },
    { value: "fade", label: "Desvanecer" },
    { value: "scale", label: "Escalar" },
    { value: "rotate", label: "Rotar" },
];

export function AnimationControl({ value, onChange }: { value: AnimSpec; onChange: (v: AnimSpec) => void }) {
    const anim = value || {};
    const active = !!anim.type;
    const scrollActive = !!anim.scroll;
    const scrollAmt = Math.min(100, Math.max(10, Math.round((Number(anim.scrollAmount ?? 30) || 0) / 10) * 10));
    return (
        // wjs-f-anim — marker for the properties panel's AVANZADO tab filter (see puck-theme.css).
        <div className="wjs-f-anim">
            <select
                value={anim.type || ""}
                onChange={(e) => onChange({ ...anim, type: e.target.value as AnimSpec["type"] })}
                className="w-full px-2 py-1.5 bg-white border border-[var(--ed-outline-variant)] rounded text-[13px] text-[var(--ed-on-surface)] focus:outline-none focus:border-[var(--ed-primary)] focus:ring-1 focus:ring-[var(--ed-primary)]"
            >
                {EFFECTS.map((e) => (
                    <option key={e.value} value={e.value}>{e.label}</option>
                ))}
            </select>
            {active && (
                <>
                    <div className="flex gap-0.5 mt-2 bg-[var(--ed-surface-container-high)] p-0.5 rounded border border-[var(--ed-outline-variant)]">
                        {DURATIONS.map((d) => {
                            const selected = (anim.duration || 600) === d.value;
                            return (
                                <button
                                    key={d.value}
                                    type="button"
                                    onClick={() => onChange({ ...anim, duration: d.value })}
                                    className={`flex-1 py-1 rounded text-[11px] font-medium transition ${
                                        selected
                                            ? "bg-[var(--ed-primary)] text-white shadow-sm"
                                            : "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                                    }`}
                                >
                                    {d.label}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                        <label className="text-[11px] font-medium text-[var(--ed-on-surface-variant)] shrink-0">Retardo</label>
                        <select
                            value={String(anim.delay || 0)}
                            onChange={(e) => onChange({ ...anim, delay: parseInt(e.target.value, 10) || 0 })}
                            className="flex-1 px-2 py-1 bg-white border border-[var(--ed-outline-variant)] rounded text-xs text-[var(--ed-on-surface)] focus:outline-none focus:border-[var(--ed-primary)] focus:ring-1 focus:ring-[var(--ed-primary)]"
                            style={{ fontFamily: "var(--puck-font-family-monospaced)" }}
                        >
                            {DELAYS.map((d) => (
                                <option key={d} value={d}>{d === 0 ? "Sin retardo" : `${d} ms`}</option>
                            ))}
                        </select>
                    </div>
                    <p className="text-[10px] text-[var(--ed-outline)] mt-1.5">
                        Se reproduce al entrar en pantalla, tanto aquí en el editor como en el sitio publicado. Usa
                        el botón <MSym name="play_arrow" size={11} className="align-[-2px]" /> de la barra superior para volver a
                        verlas, y el retardo para escalonar bloques contiguos.
                    </p>
                </>
            )}

            {/* ── Al hacer scroll — scroll-driven effect, independent of the entrance ── */}
            <div className="mt-3 pt-3 border-t border-[var(--ed-outline-variant)]">
                <label className="block text-[11px] font-medium text-[var(--ed-on-surface-variant)] mb-1.5">
                    Al hacer scroll
                </label>
                <select
                    value={anim.scroll || ""}
                    onChange={(e) => onChange({ ...anim, scroll: e.target.value as AnimSpec["scroll"] })}
                    className="w-full px-2 py-1.5 bg-white border border-[var(--ed-outline-variant)] rounded text-[13px] text-[var(--ed-on-surface)] focus:outline-none focus:border-[var(--ed-primary)] focus:ring-1 focus:ring-[var(--ed-primary)]"
                >
                    {SCROLL_EFFECTS.map((e) => (
                        <option key={e.value} value={e.value}>{e.label}</option>
                    ))}
                </select>
                {scrollActive && (
                    <>
                        <div className="flex items-center gap-2 mt-2">
                            <label className="text-[11px] font-medium text-[var(--ed-on-surface-variant)] shrink-0">
                                Intensidad
                            </label>
                            <input
                                type="range"
                                min={10}
                                max={100}
                                step={10}
                                value={scrollAmt}
                                onChange={(e) => onChange({ ...anim, scrollAmount: Number(e.target.value) })}
                                className="flex-1 h-1 accent-[#1f108e] bg-[var(--ed-surface-container-highest)] rounded-full"
                            />
                            <span
                                className="text-[11px] text-[var(--ed-primary)] w-8 text-right tabular-nums"
                                style={{ fontFamily: "var(--puck-font-family-monospaced)" }}
                            >
                                {scrollAmt}
                            </span>
                        </div>
                        <p className="text-[10px] text-[var(--ed-outline)] mt-1.5">
                            El efecto avanza y retrocede con el scroll, sin JavaScript. En navegadores sin animaciones
                            por scroll no ocurre nada; si además hay animación de entrada, el efecto de scroll tiene
                            prioridad y la entrada se omite.
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}

