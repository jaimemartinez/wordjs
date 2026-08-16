/**
 * EL SCRUBBER (§6.3) — que mueva el ESTADO REAL, no una imitación.
 *
 * ENTORNO node sin jsdom, como el resto del runtime: el scrubber recibe elementos `*Like` (el
 * subconjunto estructural de `runtime/host.ts`) justamente para poder verificarse aquí. Lo que se
 * comprueba es lo que hace un scrubber fiel y lo que distingue a uno falso:
 *
 *  1. **Los fotogramas son los del COMPILADOR**, no unos calculados aparte. Se comprueba por
 *     IDENTIDAD de referencia contra `unit.kf`: si alguien reinterpretase los pasos por su cuenta,
 *     el editor enseñaría un recorrido y el visitante vería otro.
 *  2. **La animación se POSICIONA, no corre**: `pause()` antes de tocar nada y `currentTime`
 *     asignado a mano. Si corriera, el deslizador no serviría para pararse en el 37 %.
 *  3. **El eje es ÚNICO y absoluto** para toda la unidad: al 50 % una pista con retardo puede no
 *     haber empezado. Si cada animación normalizase su propio 0–100, el escalonado desaparecería
 *     del previsualizador y el autor ajustaría un retardo que no ve.
 *  4. **Soltar devuelve el bloque al CSS**: `cancel()` en todas, y ni una animación pausada
 *     sobreviviendo al scrubber.
 */
import { describe, expect, it } from "vitest";
import { compileIx, toRuntimeUnit, IX_SYS_CTX } from "../index";
import { createIxScrubber, IX_SCRUB_MS } from "../runtime/scrubber";
import type { IxAnimateOptions, IxAnimationLike, IxDocumentLike, IxElementLike } from "../runtime/host";
import type { IxKeyframe, IxRuntimeUnit, IxSpec } from "../types";

/* ------------------------------------------------------------------ */
/* Elemento de mentira                                                 */
/* ------------------------------------------------------------------ */

type FakeAnim = IxAnimationLike & {
  kf: IxKeyframe[];
  opts: IxAnimateOptions;
  paused: boolean;
  cancelled: boolean;
};

class FakeEl implements IxElementLike {
  anims: FakeAnim[] = [];
  children: FakeEl[] = [];
  words: FakeEl[] = [];
  /** `false` para simular un navegador sin WAAPI. */
  canAnimate = true;

  getAttribute() { return null; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll(sel: string) { return sel === ".wjs-ixw" ? this.words : []; }
  getBoundingClientRect() { return { top: 0, height: 100 }; }
  get animate() {
    if (!this.canAnimate) return undefined;
    return (kf: IxKeyframe[], opts: IxAnimateOptions): IxAnimationLike => {
      const a: FakeAnim = {
        kf,
        opts,
        paused: false,
        cancelled: false,
        currentTime: null,
        pause() { a.paused = true; },
        play() { a.paused = false; },
        cancel() { a.cancelled = true; },
      };
      this.anims.push(a);
      return a;
    };
  }
}

const FAKE_DOC: IxDocumentLike = {
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};

const runtimeOf = (spec: IxSpec): IxRuntimeUnit => toRuntimeUnit(compileIx(spec, IX_SYS_CTX)!);

/* ------------------------------------------------------------------ */
/* Especificaciones de prueba                                          */
/* ------------------------------------------------------------------ */

/** Ligada al scroll: es el caso que el botón «Probar» NO sabe previsualizar. */
const SCRUB: IxSpec = {
  v: 1,
  trigger: { on: "scrub" },
  tracks: [
    {
      target: { kind: "self" },
      steps: [
        { at: 0, set: { y: 30 } },
        { at: 100, set: { y: -30 } },
      ],
    },
  ],
};

/** Temporal con escalonado sobre los hijos: el eje absoluto se ve aquí. */
const STAGGER: IxSpec = {
  v: 1,
  trigger: { on: "view", once: true },
  tracks: [
    {
      target: { kind: "children" },
      steps: [
        { at: 0, set: { opacity: 0, y: 20 }, ease: "out" },
        { at: 100, set: { opacity: 1, y: 0 } },
      ],
      dur: 400,
      delay: 100,
      stagger: { each: 200 },
    },
  ],
};

/* ------------------------------------------------------------------ */

describe("scrubber — posiciona, no reproduce", () => {
  it("crea UNA animación pausada por objetivo y no la arranca nunca", () => {
    const el = new FakeEl();
    const s = createIxScrubber(el, runtimeOf(SCRUB), FAKE_DOC)!;
    expect(s).not.toBeNull();
    expect(s.count).toBe(1);
    expect(el.anims).toHaveLength(1);
    expect(el.anims[0].paused).toBe(true);
    expect(el.anims[0].opts.fill).toBe("both");
    // `linear` a nivel de elemento: la curva de cada tramo viaja DENTRO de los fotogramas, igual
    // que el compilador la mete dentro de los @keyframes. Una curva aquí se multiplicaría.
    expect(el.anims[0].opts.easing).toBe("linear");
  });

  it("los fotogramas son EXACTAMENTE los del compilador (misma referencia, no una copia recalculada)", () => {
    const el = new FakeEl();
    const unit = runtimeOf(SCRUB);
    createIxScrubber(el, unit, FAKE_DOC);
    expect(el.anims[0].kf).toBe(unit.tracks[0].kf);
    // Y ese IR es el mismo del que salió el CSS: dos backends, un solo origen.
    expect(el.anims[0].kf).toEqual(Object.values(compileIx(SCRUB, IX_SYS_CTX)!.kf)[0]);
  });

  it("el porcentaje se traduce a `currentTime` sobre el eje de la unidad", () => {
    const el = new FakeEl();
    const s = createIxScrubber(el, runtimeOf(SCRUB), FAKE_DOC)!;
    s.set(0);
    expect(el.anims[0].currentTime).toBe(0);
    s.set(37);
    expect(el.anims[0].currentTime).toBeCloseTo(0.37 * IX_SCRUB_MS, 6);
    s.set(100);
    expect(el.anims[0].currentTime).toBe(IX_SCRUB_MS);
  });

  it("un porcentaje fuera de rango o basura se clampa (nunca un `currentTime` absurdo)", () => {
    const el = new FakeEl();
    const s = createIxScrubber(el, runtimeOf(SCRUB), FAKE_DOC)!;
    s.set(-40);
    expect(el.anims[0].currentTime).toBe(0);
    s.set(1e9);
    expect(el.anims[0].currentTime).toBe(IX_SCRUB_MS);
    s.set(Number.NaN);
    expect(el.anims[0].currentTime).toBe(0);
  });
});

describe("scrubber — el eje es ÚNICO para toda la unidad", () => {
  const withChildren = () => {
    const el = new FakeEl();
    el.children = [new FakeEl(), new FakeEl(), new FakeEl()];
    return el;
  };

  it("cada hermano conserva SU retardo y el 100 % es el final del último", () => {
    const el = withChildren();
    const s = createIxScrubber(el, runtimeOf(STAGGER), FAKE_DOC)!;
    expect(s.count).toBe(3);
    const delays = el.children.map((c) => c.anims[0].opts.delay);
    expect(delays).toEqual([100, 300, 500]); // delay base 100 + 200 por hermano
    // El eje llega hasta el mayor `delay + duración` = 500 + 400 = 900.
    s.set(100);
    for (const c of el.children) expect(c.anims[0].currentTime).toBe(900);
    // Y a mitad del recorrido el tercero AÚN NO ha empezado: 450 < su retardo de 500. Eso es lo que
    // hace que el escalonado se pueda ajustar mirando, en vez de a ciegas.
    s.set(50);
    for (const c of el.children) expect(c.anims[0].currentTime).toBe(450);
  });

  it("en el camino de scroll el escalonado NO aplica, igual que en el CSS", () => {
    const el = withChildren();
    const spec: IxSpec = {
      v: 1,
      trigger: { on: "scrub" },
      tracks: [{ ...STAGGER.tracks![0], dur: undefined, delay: undefined }],
    };
    createIxScrubber(el, runtimeOf(spec), FAKE_DOC);
    for (const c of el.children) {
      expect(c.anims[0].opts.delay).toBe(0);
      expect(c.anims[0].opts.duration).toBe(IX_SCRUB_MS);
    }
  });

  it("el objetivo `words` recorre los spans que emite el split", () => {
    const el = new FakeEl();
    el.words = [new FakeEl(), new FakeEl()];
    const spec: IxSpec = {
      v: 1,
      trigger: { on: "view", once: true },
      tracks: [{ ...STAGGER.tracks![0], target: { kind: "words" } }],
    };
    const s = createIxScrubber(el, runtimeOf(spec), FAKE_DOC)!;
    expect(s.count).toBe(2);
    expect(el.words.every((w) => w.anims.length === 1)).toBe(true);
  });
});

describe("scrubber — soltar devuelve el bloque al CSS", () => {
  it("`stop()` cancela TODAS las animaciones y deja de aceptar posiciones", () => {
    const el = new FakeEl();
    el.children = [new FakeEl(), new FakeEl()];
    const s = createIxScrubber(el, runtimeOf(STAGGER), FAKE_DOC)!;
    s.set(50);
    const before = el.children.map((c) => c.anims[0].currentTime);
    s.stop();
    expect(el.children.every((c) => c.anims[0].cancelled)).toBe(true);
    // Y después de soltar, un `set` tardío (un evento en vuelo) no revive nada.
    s.set(90);
    expect(el.children.map((c) => c.anims[0].currentTime)).toEqual(before);
    expect(() => s.stop()).not.toThrow(); // idempotente
  });

  it("sin objetivos no hay scrubber: `null`, y ni una animación colgando", () => {
    const el = new FakeEl(); // sin hijos ni palabras
    const spec: IxSpec = {
      v: 1,
      trigger: { on: "view", once: true },
      tracks: [{ ...STAGGER.tracks![0], target: { kind: "words" } }],
    };
    expect(createIxScrubber(el, runtimeOf(spec), FAKE_DOC)).toBeNull();
    expect(el.anims).toHaveLength(0);
  });

  it("sin WAAPI tampoco: el bloque se queda como está, nunca a medias", () => {
    const el = new FakeEl();
    el.canAnimate = false;
    expect(createIxScrubber(el, runtimeOf(SCRUB), FAKE_DOC)).toBeNull();
  });
});
