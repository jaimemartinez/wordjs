// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Meals — the counter tiles («Servicios», «Entregados», «Con derecho», «Pendientes»…) of the page header, the
 * «Entrega» panel and «Reporte».
 *
 * 2.16.0 (live round): the tiles sat in a fixed `grid-cols-3`, and in the «Entrega» panel — a third of the
 * screen on a desktop — each tile was 71 px wide at 1280×800 and 81 px at 1366×768: «ENTREGADOS» ran 35 px
 * into «Con derecho», «PENDIENTES» past its tile; on a phone the header's tiles did the same. Now a grid puts
 * `cols` tiles side by side only when its OWN width (a container query: the panel is a third of a desktop and
 * the whole width of a phone) gives every tile COUNTER_TILE_MIN_REM: the widest label word, «(AUTORIZADOS)»,
 * measures 86.5 px in Inter 9 px black with 0.1em tracking (91.6 px in the Arial fallback; «ENTREGADOS» 72 /
 * 78.5 px, an icon adds 13 px) and the tile's padding and border take 34 px. Narrower, one tile per row: the
 * label on the left (it wraps only between words), the number on the right. Four tiles go 4 → 2 → 1 per row.
 * The rules are a <style> of their own (unlayered): no host or plugin Tailwind build can leave them out or
 * outrank them, and a browser without container queries keeps the one-per-row layout, which always fits.
 */
import React from "react";

/** The narrowest a tile may be when it shares a row (label above the number): 136 px ≥ 91.6 + 34. */
export const COUNTER_TILE_MIN_REM = 8.5;
/** The grid width (rem) from which `n` tiles fit side by side with `gapPx` between them. */
export const countersFitRem = (n: number, gapPx: number): number => n * COUNTER_TILE_MIN_REM + ((n - 1) * gapPx) / 16;
/** How many tiles a row may hold, widest last (one per row below the first step). */
const steps = (cols: number): number[] => (cols >= 4 ? [2, cols] : cols > 1 ? [cols] : []);

/** The rules of one grid (`cols` tiles, `gapPx` apart), scoped by its data attribute. */
export function countersCss(cols: number, gapPx: number): string {
    const g = `[data-cm-counters="${cols}-${gapPx}"]`;
    return [
        `${g}{container:cm-counters / inline-size}`,
        `${g}>[data-counter-grid]{display:grid;grid-template-columns:minmax(0,1fr);gap:${gapPx}px}`,
        `${g} [data-counter]{display:flex;align-items:center;justify-content:space-between;column-gap:12px;min-width:0}`,
        `${g} [data-counter-label]{min-width:0;overflow-wrap:break-word}`,
        `${g} [data-counter-value]{flex:none;margin-top:0}`,
        ...steps(cols).map((n) => `@container cm-counters (min-width:${countersFitRem(n, gapPx)}rem){`
            + `${g}>[data-counter-grid]{grid-template-columns:repeat(${n},minmax(0,1fr))}`
            + `${g} [data-counter]{display:block}`
            + `${g} [data-counter-value]{margin-top:2px}}`),
    ].join('\n');
}

export function Counter({ label, value, tone = 'text-gray-900', icon }: { label: React.ReactNode; value: React.ReactNode; tone?: string; icon?: string }) {
    return (
        <div data-counter="" className="bg-gray-50/80 px-4 py-3 rounded-2xl border border-gray-100">
            <div data-counter-label="" className="text-[9px] font-black text-gray-400 uppercase tracking-widest">{icon && <i className={`fa-solid ${icon} mr-1`} aria-hidden="true"></i>}{label}</div>
            <div data-counter-value="" className={`text-2xl font-black italic tracking-tighter mt-0.5 tabular-nums ${tone}`}>{value}</div>
        </div>
    );
}

/** A row of `cols` Counter tiles that always fits its words (see above). */
export function Counters({ cols, gap = 8, className, children }: { cols: number; gap?: number; className?: string; children: React.ReactNode }) {
    return (
        <div data-cm-counters={`${cols}-${gap}`} className={className}>
            <div data-counter-grid="">{children}</div>
            <style>{countersCss(cols, gap)}</style>
        </div>
    );
}
