/**
 * Verso Lab — acumulador PURO de métricas de rendimiento por sesión (sin
 * React, sin DOM — testeado en node con reloj inyectable).
 *
 * Dos métricas (F2, SOLO medir — nada se optimiza aquí):
 * - "input": latencia de entrada del panel de propiedades — del keydown en un
 *   campo al FIN del transact que ese keydown produce. Protocolo mark/end:
 *   `markInput()` en el keydown (capture del panel) sella el instante;
 *   `endInput()` JUSTO después de que el transact del onChange retorne (mismo
 *   tick: transact es síncrono) consume la marca y registra la muestra. Un
 *   keydown sin onChange (flechas, Tab…) deja marca que el siguiente keydown
 *   SOBRESCRIBE; un onChange sin keydown previo (click en select/radio) no
 *   registra nada — la métrica es deliberadamente solo-teclado.
 * - "transact": coste de handle.transact en ms (ya medido por el lab).
 *
 * Estadísticos por métrica: count, p50, p95, max. Percentil = nearest-rank
 * sobre las muestras ordenadas (p = valores[⌈q·n⌉-1]); las muestras se
 * acumulan la sesión entera (reset() las vacía). Suscripción por versión para
 * useSyncExternalStore.
 */

export type PerfMetric = "input" | "transact";

export interface PerfStats {
    count: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
}

export interface PerfSnapshot {
    input: PerfStats;
    transact: PerfStats;
}

/** Percentil nearest-rank (q en [0,1]) sobre muestras SIN ordenar. null si no hay muestras. */
export function percentile(samples: readonly number[], q: number): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
    return sorted[rank - 1];
}

export function statsOf(samples: readonly number[]): PerfStats {
    if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null };
    let max = samples[0];
    for (const s of samples) if (s > max) max = s;
    return { count: samples.length, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max };
}

export interface PerfTracker {
    /** Registra una muestra (ms) de una métrica. */
    record(metric: PerfMetric, ms: number): void;
    /** keydown en un campo del panel: sella el instante (sobrescribe la marca previa). */
    markInput(): void;
    /** Fin del transact del onChange: consume la marca y registra "input". null = sin marca. */
    endInput(): number | null;
    /** Snapshot NUEVO en cada llamada (los arrays internos jamás se exponen). */
    snapshot(): PerfSnapshot;
    reset(): void;
    /** Cambia en cada record/reset — clave de useSyncExternalStore. */
    version(): number;
    subscribe(listener: () => void): () => void;
}

export function createPerfTracker(now: () => number = () => performance.now()): PerfTracker {
    const samples: Record<PerfMetric, number[]> = { input: [], transact: [] };
    let pendingInputAt: number | null = null;
    let ver = 0;
    const listeners = new Set<() => void>();

    const bump = (): void => {
        ver += 1;
        for (const listener of [...listeners]) listener();
    };

    return {
        record(metric, ms) {
            samples[metric].push(ms);
            bump();
        },
        markInput() {
            pendingInputAt = now();
        },
        endInput() {
            if (pendingInputAt === null) return null;
            const ms = now() - pendingInputAt;
            pendingInputAt = null;
            samples.input.push(ms);
            bump();
            return ms;
        },
        snapshot() {
            return { input: statsOf(samples.input), transact: statsOf(samples.transact) };
        },
        reset() {
            samples.input.length = 0;
            samples.transact.length = 0;
            pendingInputAt = null;
            bump();
        },
        version: () => ver,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
