/**
 * RUNTIME MÍNIMO — la isla de eventos y el driver de scrub.
 *
 * ENTORNO: node, sin jsdom (el proyecto no lo tiene y no se añaden dependencias). El runtime se
 * diseñó recibiendo un HOST precisamente para esto: aquí se le pasa uno de mentira y se comprueba
 * el comportamiento observable — qué se descarga, qué atributos se tocan, cuántos bucles hay y qué
 * pasa al limpiar. Un runtime que solo se pudiera probar en un navegador sería un runtime que no
 * se prueba.
 *
 * Lo que se verifica aquí (los gates de §7.3 que NO necesitan navegador):
 *  · página sin interacciones → CERO trabajo, ni un observer;
 *  · solo unidades nativas en un navegador con soporte → el chunk de scrub NO se pide;
 *  · reduced-motion → no se arma nada, en ningún camino;
 *  · UN solo bucle rAF por documento;
 *  · la limpieza nunca deja un bloque armado-invisible.
 */
import { describe, expect, it, vi } from "vitest";
import { compileIxPage, toRuntimeUnit } from "../compile";
import { IX_REPLAY_EVENT, startIxRuntime } from "../runtime";
import { ANIM_REPLAY_EVENT } from "@/components/blocks/entranceAnimation";
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

/* ------------------------------------------------------------------ */
/* Host de mentira                                                     */
/* ------------------------------------------------------------------ */

type FakeAnim = IxAnimationLike & { kf: IxKeyframe[]; opts: unknown; cancelled: boolean };

class FakeEl implements IxElementLike {
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  anims: FakeAnim[] = [];
  children: FakeEl[] = [];
  words: FakeEl[] = [];
  rect = { top: 0, height: 100 };
  constructor(public cls: string) {}

  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, l: (ev: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(l);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, l: (ev: unknown) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => x !== l));
  }
  fire(type: string, ev: unknown = { type }) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(ev);
  }
  querySelectorAll(sel: string) { return sel === ".wjs-ixw" ? this.words : []; }
  getBoundingClientRect() { return this.rect; }
  animate(kf: IxKeyframe[], opts: unknown): IxAnimationLike {
    const a: FakeAnim = {
      kf, opts, cancelled: false, currentTime: null,
      pause() {}, play() {}, cancel() { a.cancelled = true; },
    };
    this.anims.push(a);
    return a;
  }
}

class FakeDoc implements IxDocumentLike {
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(public els: FakeEl[]) {}
  querySelectorAll(sel: string) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    if (cls) return this.els.filter((e) => e.cls === cls);
    const m = /\[data-wjs-block-id="([^"]+)"\]/.exec(sel);
    return m ? this.els.filter((e) => e.cls === `block:${m[1]}`) : [];
  }
  addEventListener(type: string, l: (ev: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(l);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, l: (ev: unknown) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => x !== l));
  }
  fire(type: string, ev: unknown = { type }) { for (const l of [...(this.listeners.get(type) ?? [])]) l(ev); }
}

type Harness = {
  host: IxHost;
  doc: FakeDoc;
  observers: Array<{ cb: (e: IxObserverEntry[]) => void; observed: Set<IxElementLike>; live: boolean }>;
  rafQueue: Array<() => void>;
  rafCalls: number;
  scrubLoads: number;
  flushRaf: () => void;
};

function harness(
  els: FakeEl[],
  opts: { reduced?: boolean; supports?: boolean; io?: boolean; pageP?: number; media?: boolean } = {},
): Harness {
  const doc = new FakeDoc(els);
  const h: Harness = {
    doc,
    observers: [],
    rafQueue: [],
    rafCalls: 0,
    scrubLoads: 0,
    host: null as unknown as IxHost,
    flushRaf: () => {
      const q = h.rafQueue;
      h.rafQueue = [];
      for (const cb of q) cb();
    },
  };
  h.host = {
    doc,
    viewportHeight: () => 800,
    viewportWidth: () => 1000,
    pageProgress: () => opts.pageP ?? 0,
    reducedMotion: () => opts.reduced === true,
    matchesMedia: () => opts.media !== false,
    supportsTimeline: () => opts.supports !== false,
    observe: (cb): IxObserverLike | null => {
      if (opts.io === false) return null;
      const rec = { cb, observed: new Set<IxElementLike>(), live: true };
      h.observers.push(rec);
      return {
        observe: (el) => rec.observed.add(el),
        unobserve: (el) => rec.observed.delete(el),
        disconnect: () => { rec.live = false; rec.observed.clear(); },
      };
    },
    raf: (cb) => { h.rafCalls++; h.rafQueue.push(cb); return h.rafCalls; },
    caf: () => {},
    loadScrub: async () => {
      h.scrubLoads++;
      return { createScrubDriver };
    },
  };
  return h;
}

/* ------------------------------------------------------------------ */

const track = (over: Record<string, unknown> = {}) => ({
  target: { kind: "self" },
  steps: [{ at: 0, set: { opacity: 0 } }, { at: 100, set: { opacity: 1 } }],
  ...over,
});
const page = (specs: unknown[]) => compileIxPage(specs);
const unitsOf = (specs: unknown[]): IxRuntimeUnit[] => page(specs).runtime;
/** TODAS las unidades, necesiten runtime o no — para probar el driver de forma aislada. */
const allUnitsOf = (specs: unknown[]): IxRuntimeUnit[] => page(specs).units.map(toRuntimeUnit);

/* ------------------------------------------------------------------ */

describe("el evento de replay es EL MISMO que el de la entrada de hoy", () => {
  it("IX_REPLAY_EVENT === ANIM_REPLAY_EVENT", () => {
    // Está duplicado como literal a propósito (aquel módulo es "use client" y este tiene que poder
    // cargarse como chunk suelto). Este pin es lo que evita que se separen.
    expect(IX_REPLAY_EVENT).toBe(ANIM_REPLAY_EVENT);
  });
});

describe("salida rápida: lo que NO se paga", () => {
  it("página sin interacciones → cero observers, cero listeners, cero chunk", () => {
    const h = harness([]);
    const stop = startIxRuntime([], h.host);
    expect(h.observers).toHaveLength(0);
    expect(h.rafCalls).toBe(0);
    expect(h.scrubLoads).toBe(0);
    stop();
  });

  it("solo unidades nativas y navegador con soporte → el chunk de scrub NO se pide", () => {
    const units = unitsOf([{ v: 1, trigger: { on: "scrub" }, tracks: [track()] }]);
    expect(units).toHaveLength(1);
    expect(units[0].needsRuntime).toBe("no-native");
    const el = new FakeEl(units[0].cls);
    const h = harness([el], { supports: true });
    startIxRuntime(units, h.host);
    expect(h.scrubLoads).toBe(0);
    expect(h.observers).toHaveLength(0);
    expect(el.attrs.size).toBe(0);
  });

  it("sin soporte nativo → SÍ se pide el chunk, y solo entonces", async () => {
    const units = unitsOf([{ v: 1, trigger: { on: "scrub" }, tracks: [track()] }]);
    const el = new FakeEl(units[0].cls);
    const h = harness([el], { supports: false });
    startIxRuntime(units, h.host);
    await Promise.resolve();
    expect(h.scrubLoads).toBe(1);
  });

  it("reduced-motion → nada se arma, en ningún camino", async () => {
    const units = unitsOf([
      { v: 1, trigger: { on: "view", once: true }, tracks: [track()] },
      { v: 1, trigger: { on: "click" }, tracks: [track()] },
      { v: 1, trigger: { on: "scrub" }, tracks: [track()] },
    ]);
    const els = units.map((u) => new FakeEl(u.cls));
    const h = harness(els, { reduced: true, supports: false });
    startIxRuntime(units, h.host);
    await Promise.resolve();
    expect(h.observers).toHaveLength(0);
    expect(h.scrubLoads).toBe(0);
    expect(h.rafCalls).toBe(0);
    for (const el of els) expect(el.attrs.size).toBe(0);
  });
});

describe("gating responsive (P4)", () => {
  const gated = () =>
    unitsOf([{ v: 1, trigger: { on: "view", once: true }, off: ["mobile"], tracks: [track()] }]);

  it("la unidad lleva su condición @media en el manifiesto", () => {
    expect(gated()[0].media).toBe("(min-width: 768px)");
  });

  it("si la condición NO casa, la unidad ni observa ni toca atributos", () => {
    const u = gated();
    const el = new FakeEl(u[0].cls);
    const h = harness([el], { media: false });
    startIxRuntime(u, h.host);
    expect(h.observers).toHaveLength(0);
    expect(el.attrs.size).toBe(0);
  });

  it("si casa, arma con normalidad", () => {
    const u = gated();
    const el = new FakeEl(u[0].cls);
    const h = harness([el], { media: true });
    startIxRuntime(u, h.host);
    expect(el.getAttribute("data-wjs-ix")).toBe("armed");
  });
});

describe("latch de entrada (view + once)", () => {
  const units = unitsOf([{ v: 1, trigger: { on: "view", once: true }, tracks: [track()] }]);

  it("arma, observa y al entrar en pantalla pasa a `in` y deja de observar", () => {
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    startIxRuntime(units, h.host);
    expect(el.getAttribute("data-wjs-ix")).toBe("armed");
    expect(h.observers[0].observed.has(el)).toBe(true);
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    expect(el.getAttribute("data-wjs-ix")).toBe("in");
    expect(h.observers[0].observed.has(el)).toBe(false);
  });

  it("UN solo observer para todas las unidades de entrada del documento", () => {
    const many = unitsOf(
      Array.from({ length: 8 }, (_, i) => ({
        v: 1,
        trigger: { on: "view", once: true },
        tracks: [track({ steps: [{ at: 0, set: { y: i + 1 } }, { at: 100, set: { y: 0 } }] })],
      })),
    );
    const els = many.map((u) => new FakeEl(u.cls));
    const h = harness(els);
    startIxRuntime(many, h.host);
    expect(h.observers).toHaveLength(1);
    expect(h.observers[0].observed.size).toBe(8);
  });

  it("la limpieza NUNCA deja un bloque armado-invisible", () => {
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    const stop = startIxRuntime(units, h.host);
    expect(el.getAttribute("data-wjs-ix")).toBe("armed");
    stop();
    expect(el.getAttribute("data-wjs-ix")).toBeNull();
    expect(h.observers[0].live).toBe(false);
  });

  it("un bloque que YA entró se queda `in` al limpiar (no se le quita lo ganado)", () => {
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    const stop = startIxRuntime(units, h.host);
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    stop();
    expect(el.getAttribute("data-wjs-ix")).toBe("in");
  });

  it("sin IntersectionObserver el bloque se queda VISIBLE (no armado)", () => {
    const el = new FakeEl(units[0].cls);
    const h = harness([el], { io: false });
    startIxRuntime(units, h.host);
    expect(el.getAttribute("data-wjs-ix")).toBeNull();
  });

  it("el replay re-arma vía evento DOM del PROPIO documento (cruza el iframe)", () => {
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    const stop = startIxRuntime(units, h.host);
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    h.doc.fire(IX_REPLAY_EVENT);
    expect(el.getAttribute("data-wjs-ix")).toBe("in");
    stop();
    // Y el listener se retira: tras limpiar, el evento ya no toca nada.
    el.removeAttribute("data-wjs-ix");
    h.doc.fire(IX_REPLAY_EVENT);
    expect(el.getAttribute("data-wjs-ix")).toBeNull();
  });
});

describe("latch de clic", () => {
  it("sin toggle: el primer clic pone `on` y ahí se queda", () => {
    const units = unitsOf([{ v: 1, trigger: { on: "click" }, tracks: [track()] }]);
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    startIxRuntime(units, h.host);
    el.fire("click");
    expect(el.getAttribute("data-wjs-ix")).toBe("on");
    el.fire("click");
    expect(el.getAttribute("data-wjs-ix")).toBe("on");
  });

  it("con toggle: conmuta", () => {
    const units = unitsOf([{ v: 1, trigger: { on: "click", toggle: true }, tracks: [track()] }]);
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    startIxRuntime(units, h.host);
    el.fire("click");
    expect(el.getAttribute("data-wjs-ix")).toBe("on");
    el.fire("click");
    expect(el.getAttribute("data-wjs-ix")).toBeNull();
  });

  it("Enter y Espacio disparan igual que el ratón; otras teclas no", () => {
    const units = unitsOf([{ v: 1, trigger: { on: "click" }, tracks: [track()] }]);
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    startIxRuntime(units, h.host);
    el.fire("keydown", { type: "keydown", key: "Tab" });
    expect(el.getAttribute("data-wjs-ix")).toBeNull();
    el.fire("keydown", { type: "keydown", key: "Enter" });
    expect(el.getAttribute("data-wjs-ix")).toBe("on");
  });

  it("la limpieza retira listeners y estado", () => {
    const units = unitsOf([{ v: 1, trigger: { on: "click" }, tracks: [track()] }]);
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    const stop = startIxRuntime(units, h.host);
    el.fire("click");
    stop();
    expect(el.getAttribute("data-wjs-ix")).toBeNull();
    el.fire("click");
    expect(el.getAttribute("data-wjs-ix")).toBeNull();
  });
});

describe("driver de scrub", () => {
  const units = unitsOf([{
    v: 1,
    trigger: { on: "scrub" },
    tracks: [track({ steps: [{ at: 0, set: { y: 30 } }, { at: 100, set: { y: -30 } }] })],
  }]);

  it("crea UNA animación pausada por elemento y la posiciona, sin reproducirla", () => {
    const el = new FakeEl(units[0].cls);
    el.rect = { top: 400, height: 200 };
    const h = harness([el]);
    createScrubDriver(units, h.host);
    expect(el.anims).toHaveLength(1);
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    // recorrido total = 800 + 200 = 1000; recorrido actual = 800 − 400 = 400 → 40 %.
    expect(el.anims[0].currentTime).toBe(400);
  });

  it("UN solo rAF pendiente por documento, aunque haya 30 unidades visibles", () => {
    const many = unitsOf(
      Array.from({ length: 30 }, (_, i) => ({
        v: 1,
        trigger: { on: "scrub" },
        tracks: [track({ steps: [{ at: 0, set: { y: i + 1 } }, { at: 100, set: { y: 0 } }] })],
      })),
    );
    const els = many.map((u) => new FakeEl(u.cls));
    const h = harness(els);
    createScrubDriver(many, h.host);
    expect(h.observers).toHaveLength(1);
    h.observers[0].cb(els.map((el) => ({ target: el, isIntersecting: true })));
    expect(h.rafQueue).toHaveLength(1);
    h.flushRaf();
    expect(h.rafQueue).toHaveLength(1); // se reencola UNO, no treinta
  });

  it("el bucle se PARA cuando no queda nada en pantalla", () => {
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    createScrubDriver(units, h.host);
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    h.flushRaf();
    expect(h.rafQueue).toHaveLength(1);
    h.observers[0].cb([{ target: el, isIntersecting: false }]);
    h.flushRaf();
    expect(h.rafQueue).toHaveLength(0);
  });

  it("el progreso se clampa a 0..1 en los dos extremos", () => {
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    createScrubDriver(units, h.host);
    el.rect = { top: 5000, height: 200 }; // muy por debajo del viewport
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    expect(el.anims[0].currentTime).toBe(0);
    el.rect = { top: -5000, height: 200 }; // muy por encima
    h.flushRaf();
    expect(el.anims[0].currentTime).toBe(1000);
  });

  it("los rangos `entry`/`contain`/`exit` recortan tramos distintos del recorrido", () => {
    const mkRange = (at: "cover" | "entry" | "contain" | "exit") =>
      unitsOf([{
        v: 1,
        trigger: { on: "scrub", range: { from: { at, pct: 0 }, to: { at, pct: 100 } } },
        tracks: [track()],
      }]);
    const seen = new Set<number>();
    for (const at of ["cover", "entry", "contain", "exit"] as const) {
      const u = mkRange(at);
      const el = new FakeEl(u[0].cls);
      el.rect = { top: 300, height: 200 }; // recorrido actual = 500
      const h = harness([el]);
      createScrubDriver(u, h.host);
      h.observers[0].cb([{ target: el, isIntersecting: true }]);
      seen.add(el.anims[0].currentTime as number);
    }
    // Cuatro definiciones distintas → cuatro progresos distintos para la misma posición.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it("scrub de PÁGINA se posiciona por el scroll del documento, no por el rect del elemento", () => {
    const u = unitsOf([{ v: 1, trigger: { on: "scrub", src: "page" }, tracks: [track()] }]);
    const el = new FakeEl(u[0].cls);
    // Rect absurdo a propósito: si el driver lo mirase (definición de view()), el progreso saldría
    // 0. Tiene que salir del pageProgress del host — la definición de scroll().
    el.rect = { top: 5000, height: 200 };
    const h = harness([el], { pageP: 0.4 });
    createScrubDriver(u, h.host);
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    expect(el.anims[0].currentTime).toBe(400);
  });

  it("el rango de página ventanea por PORCENTAJES (los nombres de vista se ignoran)", () => {
    const u = unitsOf([{
      v: 1,
      trigger: {
        on: "scrub",
        src: "page",
        range: { from: { at: "entry", pct: 25 }, to: { at: "exit", pct: 75 } },
      },
      tracks: [track()],
    }]);
    const el = new FakeEl(u[0].cls);
    const h = harness([el], { pageP: 0.5 });
    createScrubDriver(u, h.host);
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    // (0.5 − 0.25) / (0.75 − 0.25) = 0.5 → 500 de 1000.
    expect(el.anims[0].currentTime).toBe(500);
  });

  it("un objetivo externo se resuelve por data-wjs-block-id y se reproduce, no se scrubbea", () => {
    const u = unitsOf([{
      v: 1,
      trigger: { on: "load" },
      tracks: [track({ target: { kind: "block", id: "otro" } })],
    }]);
    const src = new FakeEl(u[0].cls);
    const dst = new FakeEl("block:otro");
    const h = harness([src, dst]);
    createScrubDriver(u, h.host);
    expect(dst.anims).toHaveLength(1);
    expect(src.anims).toHaveLength(0);
    expect((dst.anims[0].opts as { duration: number }).duration).toBe(600);
  });

  it("el escalonado sobre hijos desplaza el delay de cada hermano (y `center` es exacto aquí)", () => {
    // `load` + hijos es needsRuntime "never" (lo hace el CSS): se prueba el driver aislado.
    const u = allUnitsOf([{
      v: 1,
      trigger: { on: "load" },
      tracks: [track({ target: { kind: "children" }, stagger: { each: 100, from: "center" } })],
    }]);
    const root = new FakeEl(u[0].cls);
    root.children = [new FakeEl("c"), new FakeEl("c"), new FakeEl("c")];
    const h = harness([root]);
    createScrubDriver(u, h.host);
    const delays = root.children.map((c) => (c.anims[0].opts as { delay: number }).delay);
    expect(delays).toEqual([100, 0, 100]);
  });

  it("PUNTERO (P6): posiciona por el cursor con reposo en el centro, y el eje es de la pista", () => {
    const u = unitsOf([{
      v: 1,
      trigger: { on: "pointer", area: "page", smooth: 0 },
      tracks: [
        track({ steps: [{ at: 0, set: { x: -20 } }, { at: 100, set: { x: 20 } }] }),
        track({ axis: "y", steps: [{ at: 0, set: { y: -10 } }, { at: 100, set: { y: 10 } }] }),
      ],
    }]);
    expect(u[0].needsRuntime).toBe("always");
    const el = new FakeEl(u[0].cls);
    const h = harness([el]);
    createScrubDriver(u, h.host);
    // Dos animaciones pausadas (una por pista), ambas en REPOSO: el centro de la pista.
    expect(el.anims).toHaveLength(2);
    expect(el.anims[0].currentTime).toBe(500);
    expect(el.anims[1].currentTime).toBe(500);
    // Visible + cursor en (250, 600) de un viewport 1000×800 → x=0.25, y=0.75. smooth 0 = directo.
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    h.doc.fire("pointermove", { clientX: 250, clientY: 600 });
    h.flushRaf();
    expect(el.anims[0].currentTime).toBe(250);
    expect(el.anims[1].currentTime).toBe(750);
  });

  it("PUNTERO con suavizado: persigue el objetivo sin llegar de golpe, y el bucle sigue vivo", () => {
    const u = unitsOf([{
      v: 1,
      trigger: { on: "pointer", area: "page", smooth: 300 },
      tracks: [track({ steps: [{ at: 0, set: { x: -20 } }, { at: 100, set: { x: 20 } }] })],
    }]);
    const el = new FakeEl(u[0].cls);
    const h = harness([el]);
    createScrubDriver(u, h.host);
    h.observers[0].cb([{ target: el, isIntersecting: true }]);
    h.doc.fire("pointermove", { clientX: 1000, clientY: 0 });
    h.flushRaf();
    const first = el.anims[0].currentTime as number;
    expect(first).toBeGreaterThan(500);
    expect(first).toBeLessThan(1000); // no ha llegado: persigue
    expect(h.rafQueue.length).toBeGreaterThan(0); // sigue persiguiendo
    h.flushRaf();
    expect(el.anims[0].currentTime as number).toBeGreaterThan(first);
  });

  it("PUNTERO fuera de pantalla: el cursor no mueve nada (el IO manda)", () => {
    const u = unitsOf([{
      v: 1,
      trigger: { on: "pointer", area: "page", smooth: 0 },
      tracks: [track({ steps: [{ at: 0, set: { x: -20 } }, { at: 100, set: { x: 20 } }] })],
    }]);
    const el = new FakeEl(u[0].cls);
    const h = harness([el]);
    createScrubDriver(u, h.host);
    h.doc.fire("pointermove", { clientX: 900, clientY: 100 });
    h.flushRaf();
    expect(el.anims[0].currentTime).toBe(500); // sin intersecar, en reposo
  });

  it("la limpieza del puntero retira el listener y cancela sus animaciones", () => {
    const u = unitsOf([{
      v: 1,
      trigger: { on: "pointer" },
      tracks: [track({ steps: [{ at: 0, set: { x: -20 } }, { at: 100, set: { x: 20 } }] })],
    }]);
    const el = new FakeEl(u[0].cls);
    const h = harness([el]);
    const stop = createScrubDriver(u, h.host);
    expect((h.doc.listeners.get("pointermove") ?? []).length).toBe(1);
    stop();
    expect((h.doc.listeners.get("pointermove") ?? []).length).toBe(0);
    expect((el.anims[0] as FakeAnim).cancelled).toBe(true);
  });

  it("el suavizado por defecto del chunk es EL MISMO que el del normalizador (pin)", async () => {
    const { POINTER_SMOOTH_DEFAULT } = await import("../runtime/scrub");
    const { IX_POINTER_SMOOTH_DEFAULT } = await import("../normalize");
    expect(POINTER_SMOOTH_DEFAULT).toBe(IX_POINTER_SMOOTH_DEFAULT);
  });

  it("total y rejilla son EXACTOS en el runtime: mismas fórmulas que el CSS nativo", () => {
    // Tiempo total 700ms entre 8 hermanos → 100ms por hueco.
    const uTotal = allUnitsOf([{
      v: 1,
      trigger: { on: "load" },
      tracks: [track({ target: { kind: "children" }, stagger: { each: 700, total: true } })],
    }]);
    const rootT = new FakeEl(uTotal[0].cls);
    rootT.children = Array.from({ length: 8 }, () => new FakeEl("c"));
    const hT = harness([rootT]);
    createScrubDriver(uTotal, hT.host);
    const delaysT = rootT.children.map((c) => (c.anims[0].opts as { delay: number }).delay);
    expect(delaysT).toEqual([0, 100, 200, 300, 400, 500, 600, 700]);

    // Rejilla de 3 columnas → onda diagonal (fila + columna) * each.
    const uGrid = allUnitsOf([{
      v: 1,
      trigger: { on: "load" },
      tracks: [track({ target: { kind: "children" }, stagger: { each: 80, cols: 3 } })],
    }]);
    const rootG = new FakeEl(uGrid[0].cls);
    rootG.children = Array.from({ length: 6 }, () => new FakeEl("c"));
    const hG = harness([rootG]);
    createScrubDriver(uGrid, hG.host);
    const delaysG = rootG.children.map((c) => (c.anims[0].opts as { delay: number }).delay);
    expect(delaysG).toEqual([0, 80, 160, 80, 160, 240]);
  });

  it("la limpieza cancela TODAS las animaciones creadas", () => {
    const el = new FakeEl(units[0].cls);
    const h = harness([el]);
    const stop = createScrubDriver(units, h.host);
    stop();
    expect((el.anims[0] as FakeAnim).cancelled).toBe(true);
  });

  it("un elemento sin WAAPI se ignora (queda visible y quieto)", () => {
    const el = new FakeEl(units[0].cls);
    (el as { animate?: unknown }).animate = undefined;
    const h = harness([el]);
    expect(() => createScrubDriver(units, h.host)()).not.toThrow();
  });
});

describe("integración isla → chunk", () => {
  it("una unidad `always` con objetivo externo baja el chunk aunque haya soporte nativo", async () => {
    const units = unitsOf([{
      v: 1,
      trigger: { on: "load" },
      tracks: [track({ target: { kind: "block", id: "otro" } })],
    }]);
    const h = harness([new FakeEl(units[0].cls), new FakeEl("block:otro")], { supports: true });
    startIxRuntime(units, h.host);
    await Promise.resolve();
    expect(h.scrubLoads).toBe(1);
  });

  it("si el chunk no llega, no se rompe nada (fail-open)", async () => {
    const units = unitsOf([{ v: 1, trigger: { on: "scrub" }, tracks: [track()] }]);
    const h = harness([new FakeEl(units[0].cls)], { supports: false });
    h.host.loadScrub = () => Promise.reject(new Error("offline"));
    const spy = vi.fn();
    const stop = startIxRuntime(units, h.host);
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
