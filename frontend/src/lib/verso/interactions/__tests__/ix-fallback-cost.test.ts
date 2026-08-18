/**
 * C6 — CUÁNTO CUESTA EL CAMINO DE RESPALDO, medido.
 *
 * El titular del motor —«cero JavaScript en el camino caliente»— es cierto en Chromium y en WebKit,
 * y FALSO en el navegador que justifica todo el respaldo: en Firefox cada `scrub`, cada `view once`
 * y cada objetivo externo corre con IntersectionObserver + rAF + WAAPI en el hilo principal. Nunca
 * se había medido. Un titular sin número es publicidad.
 *
 * Esto mide el driver DE VERDAD (`createScrubDriver`, el mismo módulo que baja el navegador) con un
 * host sintético: se cuenta lo que cuesta UN fotograma con una página cargada de movimiento. No
 * pretende ser una medida de laboratorio del motor de un navegador —el `getBoundingClientRect` de
 * mentira no provoca reflow— sino la mitad que es NUESTRA: el trabajo por fotograma que el motor
 * añade, y sobre todo su ORDEN DE MAGNITUD, para que una regresión de diseño (un bucle anidado, un
 * recálculo por elemento) salga aquí y no en el móvil de un visitante.
 *
 * El techo es deliberadamente holgado: en CI compiten con otros procesos y no se busca cazar ruido
 * de microsegundos, sino un cambio de escala.
 */
import { describe, expect, it } from "vitest";
import { compileIxPage, toRuntimeUnit } from "../compile";
import { createScrubDriver } from "../runtime/scrub";
import type {
  IxAnimationLike,
  IxDocumentLike,
  IxElementLike,
  IxHost,
  IxObserverEntry,
  IxObserverLike,
} from "../runtime/host";
import type { IxKeyframe, IxRuntimeUnit } from "../types";

/** Elemento de mentira: lo justo para que el driver haga su trabajo real. */
class BenchEl implements IxElementLike {
  children: BenchEl[] = [];
  rect: { top: number; height: number };
  anims: Array<{ currentTime: number | null }> = [];
  constructor(public cls: string, top: number) {
    this.rect = { top, height: 320 };
  }
  getAttribute() { return null; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll() { return []; }
  getBoundingClientRect() { return this.rect; }
  animate(_kf: IxKeyframe[], _o: unknown): IxAnimationLike {
    const a = { currentTime: null as number | null, pause() {}, play() {}, cancel() {} };
    this.anims.push(a);
    return a;
  }
}

class BenchDoc implements IxDocumentLike {
  constructor(public els: BenchEl[]) {}
  querySelectorAll(sel: string) {
    const cls = sel.startsWith(".") ? sel.slice(1) : "";
    return this.els.filter((e) => e.cls === cls);
  }
  addEventListener() {}
  removeEventListener() {}
}

function benchHost(els: BenchEl[]) {
  let observerCb: ((e: IxObserverEntry[]) => void) | null = null;
  const queue: Array<() => void> = [];
  const host: IxHost = {
    doc: new BenchDoc(els),
    viewportHeight: () => 900,
    viewportWidth: () => 1440,
    pageProgress: () => 0.5,
    reducedMotion: () => false,
    matchesMedia: () => true,
    supportsTimeline: () => false, // el navegador SIN timelines nativas: el caso que se mide
    observe: (cb): IxObserverLike | null => {
      observerCb = cb;
      return { observe: () => {}, unobserve: () => {}, disconnect: () => {} };
    },
    raf: (cb) => { queue.push(cb); return queue.length; },
    caf: () => {},
    loadScrub: async () => ({ createScrubDriver }),
  };
  return {
    host,
    show: (list: BenchEl[]) => observerCb?.(list.map((target) => ({ target, isIntersecting: true }))),
    frame: () => { const q = queue.splice(0); for (const cb of q) cb(); },
  };
}

/** Una página realista: N bloques con scrub, cada uno con su propia interacción. */
function scrubPage(n: number): { units: IxRuntimeUnit[]; els: BenchEl[] } {
  const specs = Array.from({ length: n }, (_, i) => ({
    v: 1,
    trigger: { on: "scrub" },
    tracks: [
      {
        target: { kind: "self" },
        // Un `y` distinto por bloque para que cada unidad tenga su propio hash (nada se deduplica).
        steps: [{ at: 0, set: { opacity: 0, y: 20 + i } }, { at: 100, set: { opacity: 1, y: 0 } }],
      },
    ],
  }));
  const page = compileIxPage(specs);
  const units = page.units.map(toRuntimeUnit);
  const els = units.map((u, i) => new BenchEl(u.cls, i * 400 - 2000));
  return { units, els };
}

/** Mediana de `runs` medidas de `frames` fotogramas: la mediana ignora el pico del arranque. */
function medianFrameUs(units: IxRuntimeUnit[], els: BenchEl[], frames: number, runs: number): number {
  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    const h = benchHost(els);
    const stop = createScrubDriver(units, h.host);
    h.show(els);
    h.frame(); // el primero arma; se mide a partir de aquí
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      // Cada fotograma mueve la página, como haría el scroll de verdad.
      for (const el of els) el.rect = { ...el.rect, top: el.rect.top - 8 };
      h.frame();
    }
    samples.push(((performance.now() - t0) * 1000) / frames);
    stop();
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe("coste del camino de respaldo (el navegador sin timelines nativas)", () => {
  it("una página con 20 bloques en scrub cuesta MENOS DE 200 µs por fotograma", () => {
    const { units, els } = scrubPage(20);
    expect(units).toHaveLength(20);
    const us = medianFrameUs(units, els, 120, 5);
    // El número medido se imprime para que quede en el registro de la ejecución, no solo el verde.
    console.log(`[C6] respaldo: ${us.toFixed(1)} µs/fotograma con 20 bloques en scrub`);
    // 200 µs es un 1,2 % de un fotograma de 16,7 ms: holgado a propósito (CI comparte CPU), pero
    // suficiente para cazar un cambio de ESCALA, que es lo que rompe un móvil.
    expect(us).toBeLessThan(200);
  });

  it("el coste crece de forma LINEAL con los bloques: nada recorre la página al cuadrado", () => {
    const small = scrubPage(10);
    const big = scrubPage(40);
    const a = medianFrameUs(small.units, small.els, 120, 5);
    const b = medianFrameUs(big.units, big.els, 120, 5);
    console.log(`[C6] 10 bloques: ${a.toFixed(1)} µs · 40 bloques: ${b.toFixed(1)} µs`);
    // Con 4× el trabajo, un algoritmo lineal cuesta ~4×. Se admite hasta 10× para no atarse al
    // ruido de la máquina; un O(n²) daría ~16× y aquí saldría rojo.
    expect(b).toBeLessThan(a * 10 + 50);
  });

  it("un bloque fuera de pantalla no cuesta NADA: el observer lo saca del bucle", () => {
    const { units, els } = scrubPage(20);
    const h = benchHost(els);
    const stop = createScrubDriver(units, h.host);
    // Nadie visible ⇒ ni un fotograma pedido: el bucle ni siquiera arranca.
    h.frame();
    for (const el of els) expect(el.anims[0].currentTime).toBeNull();
    stop();
  });
});
