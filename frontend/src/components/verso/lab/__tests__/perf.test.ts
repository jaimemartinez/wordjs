/**
 * Verso Lab — tests del acumulador de percentiles (lab/perf.ts). Reloj
 * inyectado: cero dependencia de performance.now real. ENTORNO: node.
 */
import { describe, expect, it } from "vitest";
import { createPerfTracker, percentile, statsOf } from "../perf";

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
    let t = start;
    return { now: () => t, advance: (ms) => (t += ms) };
}

describe("percentile (nearest-rank)", () => {
    it("sin muestras → null", () => {
        expect(percentile([], 0.5)).toBeNull();
    });

    it("una muestra: todos los percentiles son ella", () => {
        expect(percentile([7], 0.5)).toBe(7);
        expect(percentile([7], 0.95)).toBe(7);
    });

    it("1..100: p50=50, p95=95 (rank = ⌈q·n⌉)", () => {
        const samples = Array.from({ length: 100 }, (_, i) => i + 1);
        expect(percentile(samples, 0.5)).toBe(50);
        expect(percentile(samples, 0.95)).toBe(95);
    });

    it("no muta ni exige orden en la entrada", () => {
        const samples = [30, 10, 20];
        expect(percentile(samples, 0.5)).toBe(20);
        expect(samples).toEqual([30, 10, 20]);
    });
});

describe("statsOf", () => {
    it("vacío → count 0 y estadísticos null", () => {
        expect(statsOf([])).toEqual({ count: 0, p50: null, p95: null, max: null });
    });

    it("count/p50/p95/max coherentes", () => {
        const stats = statsOf([5, 1, 9, 3]);
        expect(stats.count).toBe(4);
        expect(stats.max).toBe(9);
        expect(stats.p50).toBe(3); // ⌈0.5·4⌉ = 2º de [1,3,5,9]
        expect(stats.p95).toBe(9); // ⌈0.95·4⌉ = 4º
    });
});

describe("createPerfTracker", () => {
    it("record acumula por métrica y bumpa la versión notificando", () => {
        const tracker = createPerfTracker(() => 0);
        let notified = 0;
        const unsub = tracker.subscribe(() => notified++);
        const v0 = tracker.version();
        tracker.record("transact", 4);
        tracker.record("transact", 8);
        tracker.record("input", 12);
        expect(tracker.version()).toBe(v0 + 3);
        expect(notified).toBe(3);
        const snap = tracker.snapshot();
        expect(snap.transact).toEqual({ count: 2, p50: 4, p95: 8, max: 8 });
        expect(snap.input).toEqual({ count: 1, p50: 12, p95: 12, max: 12 });
        unsub();
    });

    it("markInput/endInput miden keydown → fin del transact con el reloj inyectado", () => {
        const clock = makeClock(1000);
        const tracker = createPerfTracker(clock.now);
        tracker.markInput(); // keydown
        clock.advance(23.5); // onChange + transact
        expect(tracker.endInput()).toBe(23.5);
        expect(tracker.snapshot().input).toEqual({ count: 1, p50: 23.5, p95: 23.5, max: 23.5 });
    });

    it("endInput sin marca (onChange por ratón: select/radio) no registra nada", () => {
        const tracker = createPerfTracker(() => 0);
        expect(tracker.endInput()).toBeNull();
        expect(tracker.snapshot().input.count).toBe(0);
    });

    it("la marca se consume: dos endInput seguidos solo registran una muestra", () => {
        const clock = makeClock();
        const tracker = createPerfTracker(clock.now);
        tracker.markInput();
        clock.advance(5);
        expect(tracker.endInput()).toBe(5);
        expect(tracker.endInput()).toBeNull();
        expect(tracker.snapshot().input.count).toBe(1);
    });

    it("un keydown sin onChange se SOBRESCRIBE por el siguiente (no infla la muestra)", () => {
        const clock = makeClock();
        const tracker = createPerfTracker(clock.now);
        tracker.markInput(); // flecha: no produce onChange
        clock.advance(1000);
        tracker.markInput(); // tecla real
        clock.advance(7);
        expect(tracker.endInput()).toBe(7); // NO 1007
    });

    it("reset vacía muestras y marca pendiente, y notifica", () => {
        const clock = makeClock();
        const tracker = createPerfTracker(clock.now);
        tracker.record("transact", 3);
        tracker.markInput();
        tracker.reset();
        expect(tracker.snapshot()).toEqual({
            input: { count: 0, p50: null, p95: null, max: null },
            transact: { count: 0, p50: null, p95: null, max: null },
        });
        clock.advance(9);
        expect(tracker.endInput()).toBeNull(); // la marca no sobrevive al reset
    });
});
