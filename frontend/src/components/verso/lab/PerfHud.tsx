"use client";
/**
 * Verso Lab — HUD de percentiles por sesión (F2: SOLO medir, nada se optimiza).
 *
 * Pinta input latency y coste de transact con p50/p95/max + contador desde el
 * PerfTracker (lab/perf.ts, puro y testeado), suscrito por versión vía
 * useSyncExternalStore. Botón de reset.
 *
 * LEGIBLE POR JS (contrato con el orquestador del gate): el contenedor
 * [data-wjs-perf-hud] estampa data-attrs numéricos (data-input-p50, …,
 * data-transact-max, data-*-count; ms con 1 decimal, "" = sin muestras) Y
 * ADEMÁS se publica `window.__versoPerf` = { snapshot, reset } mientras el HUD
 * está montado (se retira al desmontar). Ambas vías leen el MISMO tracker.
 */
import React from "react";
import { createPerfTracker, type PerfSnapshot, type PerfStats, type PerfTracker } from "./perf";

export { createPerfTracker, type PerfTracker };

declare global {
    interface Window {
        /** Lectura del gate de rendimiento del lab (solo con el HUD montado). */
        __versoPerf?: { snapshot(): PerfSnapshot; reset(): void };
    }
}

const fmt = (v: number | null): string => (v === null ? "" : v.toFixed(1));
const show = (v: number | null): string => (v === null ? "—" : `${v.toFixed(1)}ms`);

function StatsInline({ label, stats }: { label: string; stats: PerfStats }) {
    return (
        <span>
            {label} p50 {show(stats.p50)} · p95 {show(stats.p95)} · max {show(stats.max)} · n=
            {stats.count}
        </span>
    );
}

export interface PerfHudProps {
    tracker: PerfTracker;
}

export default function PerfHud({ tracker }: PerfHudProps) {
    const subscribe = React.useCallback(
        (onChange: () => void) => tracker.subscribe(onChange),
        [tracker],
    );
    const getVersion = React.useCallback(() => tracker.version(), [tracker]);
    React.useSyncExternalStore(subscribe, getVersion, getVersion);
    const snap = tracker.snapshot();

    // window.__versoPerf mientras el HUD viva (el orquestador lo lee en el gate).
    React.useEffect(() => {
        window.__versoPerf = { snapshot: () => tracker.snapshot(), reset: () => tracker.reset() };
        return () => {
            delete window.__versoPerf;
        };
    }, [tracker]);

    return (
        <span
            data-wjs-perf-hud=""
            data-input-p50={fmt(snap.input.p50)}
            data-input-p95={fmt(snap.input.p95)}
            data-input-max={fmt(snap.input.max)}
            data-input-count={snap.input.count}
            data-transact-p50={fmt(snap.transact.p50)}
            data-transact-p95={fmt(snap.transact.p95)}
            data-transact-max={fmt(snap.transact.max)}
            data-transact-count={snap.transact.count}
            className="flex items-center gap-2 rounded bg-[var(--ed-surface-container-high,#e8e6f0)] px-2 py-0.5 font-mono text-[11px] text-[var(--ed-on-surface-variant,#6b6880)]"
        >
            <StatsInline label="input" stats={snap.input} />
            <StatsInline label="transact" stats={snap.transact} />
            <button
                type="button"
                aria-label="Reiniciar métricas de rendimiento"
                className="rounded border border-[var(--ed-outline-variant,#d5d2e0)] px-1 text-[10px] hover:bg-[var(--ed-surface-container,#f0eef6)]"
                onClick={() => tracker.reset()}
            >
                reset
            </button>
        </span>
    );
}
