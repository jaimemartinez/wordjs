/**
 * MATRIZ DE DISPARADORES — qué se expresa en CSS puro, qué no, y cuánto JS cuesta cada caso.
 *
 * Esta es la tabla que manda en todo el diseño (§4.2 de la spec) y por eso se prueba entera: si un
 * caso cambia de columna, cambia el presupuesto de bytes de la página y hay que saberlo aquí, no
 * en un perfil de navegador.
 *
 *   never      → cero bytes de motor, en TODOS los navegadores.
 *   no-native  → el CSS lo hace en Chrome/Safari 26+; solo Firefox baja el chunk.
 *   always     → el CSS no puede: la isla de eventos, siempre.
 */
import { describe, expect, it } from "vitest";
import { compileIx, compileIxPage, ixMediaOf, toRuntimeUnit } from "../compile";
import { IX_MAX_CHILDREN } from "../normalize";
import { SYS_IX_PRESETS } from "../presets";
import type { IxSpec, IxStep, IxTrack } from "../types";

const steps2 = [
  { at: 0, set: { opacity: 0 } },
  { at: 100, set: { opacity: 1 } },
];
const steps3 = [
  { at: 0, set: { opacity: 0 } },
  { at: 50, set: { opacity: 0.5 } },
  { at: 100, set: { opacity: 1 } },
];

const mk = (trigger: IxSpec["trigger"], track: Partial<IxTrack> = {}): IxSpec => ({
  v: 1,
  trigger,
  tracks: [{ target: { kind: "self" }, steps: steps2, ...track } as IxTrack],
});

describe("la columna `needsRuntime`", () => {
  const cases: Array<[string, IxSpec, "never" | "no-native" | "always"]> = [
    ["scrub (progreso ligado al scroll)", mk({ on: "scrub" }), "no-native"],
    ["scrub sobre el scroll de la página", mk({ on: "scrub", src: "page" }), "no-native"],
    ["view, once:false (entra y sale)", mk({ on: "view", once: false }), "no-native"],
    ["view, once:true (la entrada de hoy)", mk({ on: "view", once: true }), "always"],
    ["view sin `once` (por defecto once)", mk({ on: "view" }), "always"],
    ["load", mk({ on: "load" }), "never"],
    ["load con retardo", mk({ on: "load", delay: 300 }), "never"],
    ["hover, 2 pasos", mk({ on: "hover" }), "never"],
    ["hover, 3 pasos", mk({ on: "hover" }, { steps: steps3 }), "never"],
    ["click", mk({ on: "click" }), "always"],
    ["click con toggle", mk({ on: "click", toggle: true }), "always"],
    [
      "objetivo externo (otro bloque)",
      mk({ on: "load" }, { target: { kind: "block", id: "abc" } }),
      "always",
    ],
    ["stagger sobre hijos, con load", mk({ on: "load" }, { target: { kind: "children" }, stagger: { each: 60 } }), "never"],
    ["stagger sobre palabras, con load", mk({ on: "load" }, { target: { kind: "words" }, stagger: { each: 40 } }), "never"],
    ["sin disparador → view+once", { v: 1, tracks: [{ target: { kind: "self" }, steps: steps2 }] }, "always"],
  ];

  for (const [name, spec, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(compileIx(spec)!.needsRuntime).toBe(expected);
    });
  }

  it("una página SIN nada que el CSS no resuelva no lleva manifiesto de runtime", () => {
    const page = compileIxPage([mk({ on: "load" }), mk({ on: "hover" })]);
    expect(page.units).toHaveLength(2);
    expect(page.runtime).toHaveLength(0);
  });

  it("una página con un solo caso `always` lo lleva, y solo ese", () => {
    const page = compileIxPage([mk({ on: "load" }), mk({ on: "click" }), mk({ on: "scrub" })]);
    expect(page.runtime.map((u) => u.needsRuntime).sort()).toEqual(["always", "no-native"]);
  });
});

describe("qué CSS emite cada disparador", () => {
  it("scrub → @supports + animation-timeline + animation-range, y NADA fuera del @supports", () => {
    const u = compileIx(mk({ on: "scrub" }))!;
    expect(u.rules).toHaveLength(1);
    expect(u.rules[0]).toBe(
      `@supports (animation-timeline:view()){.${u.cls}{animation:wjs-ixk-${u.hash} 1ms linear both;animation-timeline:view();animation-range:cover 0% cover 100%}}`,
    );
  });

  it("scrub sobre la página usa scroll() en la regla Y en el @supports", () => {
    const u = compileIx(mk({ on: "scrub", src: "page" }))!;
    expect(u.rules[0].startsWith("@supports (animation-timeline:scroll()){")).toBe(true);
    expect(u.rules[0]).toContain("animation-timeline:scroll()");
  });

  it("scrub de página NO emite nombres de rango de vista (y el rango 0–100 se omite: es el inicial)", () => {
    // `cover`/`entry`/… están definidos para timelines de VISTA; sobre `scroll()` su comportamiento
    // queda en manos de cada motor. El compilador emite solo porcentajes — lo único con significado.
    const u = compileIx(mk({ on: "scrub", src: "page" }))!;
    expect(u.rules[0]).not.toContain("animation-range");
    expect(u.rules[0]).not.toContain("cover");
  });

  it("scrub de página con rango del autor emite SOLO los porcentajes", () => {
    const u = compileIx(mk({
      on: "scrub",
      src: "page",
      range: { from: { at: "cover", pct: 20 }, to: { at: "cover", pct: 80 } },
    }))!;
    expect(u.rules[0]).toContain("animation-range:20% 80%");
    expect(u.rules[0]).not.toContain("cover");
  });

  it("el atajo `animation` va ANTES de animation-timeline (el atajo la resetea)", () => {
    // Solo dentro del bloque de declaraciones: el `@supports (animation-timeline:…)` de fuera es
    // una condición, no una declaración.
    const decls = compileIx(mk({ on: "scrub" }))!.rules[0].split("{").pop()!;
    expect(decls.indexOf("animation:")).toBeLessThan(decls.indexOf("animation-timeline:"));
  });

  it("view once:false usa el rango por defecto `entry 0% cover 40%`", () => {
    const u = compileIx(mk({ on: "view", once: false }))!;
    expect(u.rules[0]).toContain("animation-range:entry 0% cover 40%");
  });

  it("el rango del autor manda sobre el defecto", () => {
    const u = compileIx(mk({
      on: "scrub",
      range: { from: { at: "entry", pct: 25 }, to: { at: "exit", pct: 75 } },
    }))!;
    expect(u.rules[0]).toContain("animation-range:entry 25% exit 75%");
  });

  it("view once:true escribe contra el atributo del runtime, y arma con el fotograma 0", () => {
    const u = compileIx(mk({ on: "view", once: true }, {
      steps: [{ at: 0, set: { opacity: 0, y: 20 } }, { at: 100, set: { opacity: 1, y: 0 } }],
    }))!;
    expect(u.rules[0]).toBe(`.${u.cls}[data-wjs-ix="in"]{animation:wjs-ixk-${u.hash} 600ms linear both}`);
    expect(u.rules[1]).toBe(`.${u.cls}[data-wjs-ix="armed"]{opacity:0;transform:translate3d(0px,20px,0)}`);
    // El servidor NO puede ocultar: el estado armado solo existe bajo un atributo que pone el JS.
    expect(u.rules.every((r) => !r.startsWith(`.${u.cls}{`))).toBe(true);
  });

  it("click escribe contra [data-wjs-ix=\"on\"]", () => {
    const u = compileIx(mk({ on: "click" }))!;
    expect(u.rules[0].startsWith(`.${u.cls}[data-wjs-ix="on"]{`)).toBe(true);
  });

  it("hover con 2 pasos es una TRANSICIÓN (vuelve sola al salir el ratón)", () => {
    const u = compileIx(mk({ on: "hover" }, {
      steps: [{ at: 0, set: { scale: 1 } }, { at: 100, set: { scale: 1.05 } }],
      dur: 200,
    }))!;
    expect(u.rules).toHaveLength(2);
    expect(u.rules[0]).toBe(
      `.${u.cls}{transition:transform 200ms cubic-bezier(.16,1,.3,1) 0ms;transform:scale(1)}`,
    );
    expect(u.rules[1]).toBe(`.${u.cls}:hover,.${u.cls}:focus-visible{transform:scale(1.05)}`);
    expect(u.keyframes).toHaveLength(0); // una transición no necesita @keyframes
  });

  it("hover con 3+ pasos es una ANIMACIÓN sobre :hover (una transición no tiene pasos)", () => {
    const u = compileIx(mk({ on: "hover" }, { steps: steps3 }))!;
    expect(u.rules).toHaveLength(1);
    expect(u.rules[0]).toBe(
      `.${u.cls}:hover,.${u.cls}:focus-visible{animation:wjs-ixk-${u.hash} 600ms linear both}`,
    );
    expect(u.keyframes).toHaveLength(1);
  });

  it("`:focus-visible` acompaña SIEMPRE a `:hover` (teclado)", () => {
    for (const steps of [steps2, steps3]) {
      const u = compileIx(mk({ on: "hover" }, { steps }))!;
      expect(u.rules.join()).toContain(":focus-visible");
    }
  });

  it("load suma el retardo del disparador al de la pista", () => {
    const u = compileIx(mk({ on: "load", delay: 300 }, { delay: 200 }))!;
    expect(u.rules[0]).toContain("500ms both");
  });

  it("repeat/alt solo aparecen cuando no son el valor inicial", () => {
    expect(compileIx(mk({ on: "load" }))!.rules[0]).toBe(
      `.${compileIx(mk({ on: "load" }))!.cls}{animation:wjs-ixk-${compileIx(mk({ on: "load" }))!.hash} 600ms linear both}`,
    );
    const rep = compileIx(mk({ on: "load" }, { repeat: "inf", alt: true }))!;
    expect(rep.rules[0]).toContain("600ms linear infinite alternate both");
  });

  it("un objetivo externo NO emite CSS y avisa de que va por runtime", () => {
    const u = compileIx(mk({ on: "load" }, { target: { kind: "block", id: "abc" } }))!;
    expect(u.rules).toHaveLength(0);
    expect(u.keyframes).toHaveLength(0);
    expect(u.warnings.join(" ")).toContain("objetivo externo");
    // Pero el IR SÍ está, porque el runtime lo necesita.
    expect(Object.keys(u.kf)).toHaveLength(1);
  });
});

describe("escalonado", () => {
  it("sobre hijos emite nth-child 1..23 + catch-all + la regla NATIVA de sibling-index()", () => {
    const u = compileIx(mk({ on: "load" }, { target: { kind: "children" }, stagger: { each: 60 } }))!;
    // 1 regla principal + 23 nth-child + 1 catch-all + 1 nativa (@supports sibling-index)
    expect(u.rules).toHaveLength(1 + IX_MAX_CHILDREN + 1);
    expect(u.rules[1]).toBe(`.${u.cls}>:nth-child(1){animation-delay:0ms}`);
    expect(u.rules[2]).toBe(`.${u.cls}>:nth-child(2){animation-delay:60ms}`);
    expect(u.rules[IX_MAX_CHILDREN - 1]).toBe(`.${u.cls}>:nth-child(23){animation-delay:1320ms}`);
    expect(u.rules[IX_MAX_CHILDREN]).toBe(`.${u.cls}>:nth-child(n+24){animation-delay:1380ms}`);
    // La nativa: UNA regla, sin tope de hermanos, condicionada por su propia expresión, y con
    // selector `>:nth-child(n)` — misma especificidad que el fallback y posterior: gana el empate.
    expect(u.rules[IX_MAX_CHILDREN + 1]).toBe(
      `@supports (animation-delay:calc((sibling-index() - 1) * 60ms + 0ms)){.${u.cls}>:nth-child(n){animation-delay:calc((sibling-index() - 1) * 60ms + 0ms)}}`,
    );
  });

  it("`from: center` nativo es EXACTO (abs + sibling-count) y el fallback cae a start avisando", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 50, from: "center" },
    }))!;
    expect(u.warnings.join(" ")).toContain("centro");
    expect(u.rules[1]).toContain(">:nth-child(1){");
    const native = u.rules[u.rules.length - 1];
    expect(native).toContain("abs(sibling-index() - (sibling-count() + 1) / 2)");
  });

  it("modo TIEMPO TOTAL: nativo exacto con sibling-count; fallback reparte entre 8 y avisa", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 700, total: true },
    }))!;
    const native = u.rules[u.rules.length - 1];
    expect(native).toContain("(700ms / max(1,sibling-count() - 1))");
    // Fallback: 700 / (8-1) = 100ms por hermano.
    expect(u.rules[2]).toBe(`.${u.cls}>:nth-child(2){animation-delay:100ms}`);
    expect(u.warnings.join(" ")).toContain("8 hermanos");
  });

  it("REJILLA: onda diagonal fila+columna con las columnas del autor; `from` se ignora avisando", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 80, cols: 3, from: "end" },
    }))!;
    const native = u.rules[u.rules.length - 1];
    expect(native).toContain("round(down,(sibling-index() - 1) / 3)");
    expect(native).toContain("mod((sibling-index() - 1),3)");
    expect(u.warnings.join(" ")).toContain("diagonal");
    // El fallback de la rejilla es lineal por nth-child (nunca nth-last-child: `from` no aplica).
    expect(u.rules[1]).toContain(">:nth-child(1){");
  });

  it("el runtime WAAPI lleva total y cols en el manifiesto (paridad exacta con el nativo)", () => {
    const u = compileIx(mk({ on: "view", once: true }, {
      target: { kind: "children" }, stagger: { each: 700, total: true, cols: 3 },
    }))!;
    expect(toRuntimeUnit(u).tracks[0].stagger).toEqual({ each: 700, from: "start", total: true, cols: 3 });
  });

  it("`from: end` usa nth-last-child, que es EXACTO sin conocer el recuento", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 50, from: "end" },
    }))!;
    expect(u.rules[1]).toContain(">:nth-last-child(1){");
    expect(u.warnings).toHaveLength(0);
  });

  it("`from: center` no es expresable en CSS puro: avisa y cae a `start`", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 50, from: "center" },
    }))!;
    expect(u.warnings.join(" ")).toContain("centro");
    expect(u.rules[1]).toContain(">:nth-child(1){");
    // …pero el manifiesto del runtime SÍ conserva `center`: allí se conoce el recuento y es exacto.
    expect(toRuntimeUnit(u).tracks[0].stagger).toEqual({ each: 50, from: "center" });
  });

  it("sobre palabras es UNA regla con calc() y la variable del motor", () => {
    const u = compileIx(mk({ on: "load" }, { target: { kind: "words" }, stagger: { each: 40 } }))!;
    expect(u.rules).toHaveLength(1);
    expect(u.rules[0]).toBe(
      `.${u.cls} .wjs-ixw{animation:wjs-ixk-${u.hash} 600ms linear both;animation-delay:calc(var(--wjs-ixv-i, 0) * 40ms + 0ms)}`,
    );
  });

  it("con hover de 2 pasos el escalonado va sobre transition-delay, no animation-delay", () => {
    const u = compileIx(mk({ on: "hover" }, {
      target: { kind: "children" }, stagger: { each: 30 },
      steps: [{ at: 0, set: { y: 0 } }, { at: 100, set: { y: -4 } }],
    }))!;
    expect(u.rules.join()).toContain("transition-delay:30ms");
    expect(u.rules.join()).not.toContain("animation-delay");
  });

  it("con un disparador de scroll el escalonado se ignora y se avisa", () => {
    const u = compileIx(mk({ on: "scrub" }, { target: { kind: "children" }, stagger: { each: 60 } }))!;
    expect(u.rules).toHaveLength(1);
    expect(u.warnings.join(" ")).toContain("escalonado");
  });

  it("sobre `self` no hay hermanos que escalonar: se ignora y se AVISA (antes era silencio)", () => {
    const u = compileIx(mk({ on: "load" }, { stagger: { each: 60 } }))!;
    expect(u.warnings.join(" ")).toContain("hermanos");
  });

  it("sobre un objetivo externo tampoco: mismo aviso", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "block", id: "abc" }, stagger: { each: 60 },
    }))!;
    expect(u.warnings.join(" ")).toContain("hermanos");
  });
});

describe("easing (P2): bezier propio y físicas compiladas a linear()", () => {
  const stepsBez: IxStep[] = [
    { at: 0, set: { opacity: 0 }, bez: [0.2, 1.8, 0.4, 1] },
    { at: 100, set: { opacity: 1 } },
  ];

  it("un paso con `bez` emite SU cubic-bezier, formateado por el emisor", () => {
    const u = compileIx(mk({ on: "load" }, { steps: stepsBez }))!;
    expect(u.keyframes[0]).toContain("animation-timing-function:cubic-bezier(0.2,1.8,0.4,1)");
  });

  it("`bez` GANA a `ease` cuando conviven", () => {
    const steps: IxStep[] = [
      { at: 0, set: { opacity: 0 }, ease: "out", bez: [0, 0, 1, 1] },
      { at: 100, set: { opacity: 1 } },
    ];
    const u = compileIx(mk({ on: "load" }, { steps }))!;
    expect(u.keyframes[0]).toContain("cubic-bezier(0,0,1,1)");
    expect(u.keyframes[0]).not.toContain("cubic-bezier(.16,1,.3,1)");
  });

  it("el bezier hostil se clampa: X a 0..1, Y a ±4 — y nada más llega al CSS", () => {
    // Dato HOSTIL a propósito (fuera del tipo): entra por la frontera `unknown` del compilador.
    const steps = [
      { at: 0, set: { opacity: 0 }, bez: [-5, 999, 2, -999] },
      { at: 100, set: { opacity: 1 } },
    ] as unknown as IxStep[];
    const u = compileIx(mk({ on: "load" }, { steps }))!;
    expect(u.keyframes[0]).toContain("cubic-bezier(0,4,1,-4)");
  });

  it("un `bez` que no son 4 números finitos se DESCARTA (fail-open al ease o a nada)", () => {
    for (const bad of [[0.1, 0.2, 0.3], "0,0,1,1", [0, 0, 1, "x"], [0, NaN, 1, 1], null]) {
      const steps = [
        { at: 0, set: { opacity: 0 }, bez: bad },
        { at: 100, set: { opacity: 1 } },
      ] as unknown as IxStep[];
      const u = compileIx(mk({ on: "load" }, { steps }))!;
      expect(u.keyframes[0]).not.toContain("cubic-bezier(");
    }
  });

  it("`bounce` y `elastic` emiten una linear() muestreada que ACABA en 1", () => {
    for (const ease of ["bounce", "elastic"] as const) {
      const u = compileIx(mk({ on: "load" }, {
        steps: [{ at: 0, set: { y: 20 }, ease }, { at: 100, set: { y: 0 } }],
      }))!;
      const m = /animation-timing-function:linear\(([^)]+)\)/.exec(u.keyframes[0]);
      expect(m, `${ease} no emitió linear()`).not.toBeNull();
      const pts = m![1].split(",").map(Number);
      expect(pts.length).toBeGreaterThanOrEqual(20);
      expect(pts[0]).toBe(0);
      expect(pts[pts.length - 1]).toBe(1);
      expect(pts.every(Number.isFinite)).toBe(true);
    }
  });

  it("el elástico rebasa 1 por el camino (si no, no es elástico)", () => {
    const u = compileIx(mk({ on: "load" }, {
      steps: [{ at: 0, set: { y: 20 }, ease: "elastic" }, { at: 100, set: { y: 0 } }],
    }))!;
    const m = /linear\(([^)]+)\)/.exec(u.keyframes[0])!;
    expect(Math.max(...m[1].split(",").map(Number))).toBeGreaterThan(1);
  });

  it("el IR WAAPI lleva la MISMA curva (paridad de backends)", () => {
    const u = compileIx(mk({ on: "load" }, { steps: stepsBez }))!;
    expect(Object.values(u.kf)[0][0].easing).toBe("cubic-bezier(0.2,1.8,0.4,1)");
    const b = compileIx(mk({ on: "load" }, {
      steps: [{ at: 0, set: { y: 20 }, ease: "bounce" }, { at: 100, set: { y: 0 } }],
    }))!;
    expect(Object.values(b.kf)[0][0].easing).toMatch(/^linear\(/);
  });

  it("`bez` entra en el hash: dos curvas distintas son dos unidades distintas", () => {
    const otherBez: IxStep[] = [
      { at: 0, set: { opacity: 0 }, bez: [0.3, 1.8, 0.4, 1] },
      { at: 100, set: { opacity: 1 } },
    ];
    const a = compileIx(mk({ on: "load" }, { steps: stepsBez }))!;
    const b = compileIx(mk({ on: "load" }, { steps: otherBez }))!;
    expect(a.hash).not.toBe(b.hash);
  });

  it("en el hover de 2 pasos el bezier propio conduce la transición", () => {
    const steps: IxStep[] = [
      { at: 0, set: { scale: 1 }, bez: [0.5, 2, 0.5, 1] },
      { at: 100, set: { scale: 1.1 } },
    ];
    const u = compileIx(mk({ on: "hover" }, { steps }))!;
    expect(u.rules[0]).toContain("cubic-bezier(0.5,2,0.5,1)");
  });
});

describe("propiedades P3: transform 3D, filtros, colores, origin, clipDir, perspectiva", () => {
  const two = (a: Record<string, unknown>, b: Record<string, unknown>): IxStep[] =>
    [{ at: 0, set: a }, { at: 100, set: b }] as unknown as IxStep[];

  it("los transform nuevos salen en ORDEN FIJO y con perspective delante cuando hay 3D", () => {
    const u = compileIx(mk({ on: "load" }, {
      steps: two(
        { z: -100, scaleX: 0.5, scaleY: 1.5, rotateY: 90, skewX: 10, skewY: -5 },
        { z: 0, scaleX: 1, scaleY: 1, rotateY: 0, skewX: 0, skewY: 0 },
      ),
    }))!;
    expect(u.keyframes[0]).toContain(
      "transform:perspective(1000px) translate3d(0px,0px,-100px) scaleX(0.5) scaleY(1.5) rotateY(90deg) skewX(10deg) skewY(-5deg)",
    );
  });

  it("la perspectiva es configurable por pista y 1000 (el defecto) no cambia ni un byte", () => {
    const custom = compileIx(mk({ on: "load" }, { persp: 500, steps: two({ rotateY: 90 }, { rotateY: 0 }) }))!;
    expect(custom.keyframes[0]).toContain("perspective(500px)");
    const def = compileIx(mk({ on: "load" }, { persp: 1000, steps: two({ rotateX: 70 }, { rotateX: 0 }) }))!;
    const plain = compileIx(mk({ on: "load" }, { steps: two({ rotateX: 70 }, { rotateX: 0 }) }))!;
    expect(def.hash).toBe(plain.hash); // persp=1000 se borra al normalizar: ausencia = defecto
  });

  it("los filtros nuevos comparten UNA declaración `filter` en orden canónico", () => {
    const u = compileIx(mk({ on: "load" }, {
      steps: two(
        { blur: 5, brightness: 2, contrast: 1.5, saturate: 0.2, grayscale: 80, hue: 90 },
        { blur: 0, brightness: 1, contrast: 1, saturate: 1, grayscale: 0, hue: 0 },
      ),
    }))!;
    expect(u.keyframes[0]).toContain(
      "filter:blur(5px) brightness(2) contrast(1.5) saturate(0.2) grayscale(80%) hue-rotate(90deg)",
    );
  });

  it("los colores se emiten como #rrggbb SOLO en los pasos que los declaran (sin relleno neutro)", () => {
    const u = compileIx(mk({ on: "load" }, {
      steps: [
        { at: 0, set: { bgColor: 0xff8800, opacity: 0 } },
        { at: 50, set: { opacity: 0.5 } },
        { at: 100, set: { bgColor: 0x0044ff, opacity: 1 } },
      ] as unknown as IxStep[],
    }))!;
    const kf = u.keyframes[0];
    expect(kf).toContain("background-color:#ff8800");
    expect(kf).toContain("background-color:#0044ff");
    // El paso intermedio NO gana un color inventado: interpola desde el estilo del bloque.
    const mid = /50%\{([^}]*)\}/.exec(kf)![1];
    expect(mid).not.toContain("background-color");
    // Y la opacidad SÍ se rellena con el neutro en todos, como siempre.
    expect(mid).toContain("opacity:0.5");
  });

  it("un color con ceros a la izquierda conserva los 6 dígitos", () => {
    const u = compileIx(mk({ on: "load" }, {
      steps: two({ textColor: 0x000012, opacity: 0 }, { textColor: 0xffffff, opacity: 1 }),
    }))!;
    expect(u.keyframes[0]).toContain("color:#000012");
  });

  it("clipDir cambia el borde recortado; `right` (el de siempre) no cambia bytes ni hash", () => {
    const mkClip = (extra: Record<string, unknown>) =>
      compileIx(mk({ on: "load" }, { ...extra, steps: two({ clip: 0 }, { clip: 100 }) }))!;
    expect(mkClip({ clipDir: "up" }).keyframes[0]).toContain("clip-path:inset(100% 0 0 0)");
    expect(mkClip({ clipDir: "center-h" }).keyframes[0]).toContain("clip-path:inset(0 50% 0 50%)");
    expect(mkClip({ clipDir: "right" }).hash).toBe(mkClip({}).hash);
    expect(mkClip({}).keyframes[0]).toContain("clip-path:inset(0 100% 0 0)");
  });

  it("`origin` emite UNA regla transform-origin propia, sin estado y fuera de @supports", () => {
    const u = compileIx(mk({ on: "scrub" }, { origin: "top-left", steps: two({ rotate: 0 }, { rotate: 45 }) }))!;
    expect(u.rules.some((r) => r === `.${u.cls}{transform-origin:0% 0%}`)).toBe(true);
    // Y `center` (el inicial) no emite nada: ausencia = defecto.
    const c = compileIx(mk({ on: "scrub" }, { origin: "center", steps: two({ rotate: 0 }, { rotate: 45 }) }))!;
    expect(c.rules.every((r) => !r.includes("transform-origin"))).toBe(true);
  });

  it("el IR WAAPI lleva los colores por su clave camelCase", () => {
    const u = compileIx(mk({ on: "load" }, {
      steps: two({ bgColor: 0xff0000, opacity: 0 }, { opacity: 1 }),
    }))!;
    const first = Object.values(u.kf)[0][0];
    expect(first.backgroundColor).toBe("#ff0000");
    expect(Object.values(u.kf)[0][1].backgroundColor).toBeUndefined();
  });

  it("un cuerpo SOLO con las 8 propiedades de siempre emite bytes idénticos a los de antes de P3", () => {
    // El pin de paridad: la regla completa, byte a byte, como en los tests previos a P3.
    const u = compileIx(mk({ on: "view", once: true }, {
      steps: two({ opacity: 0, y: 20 }, { opacity: 1, y: 0 }),
    }))!;
    expect(u.rules[1]).toBe(`.${u.cls}[data-wjs-ix="armed"]{opacity:0;transform:translate3d(0px,20px,0)}`);
  });
});

describe("gating responsive (P4): la condición @media sale de la lista cerrada", () => {
  it("cada combinación de apagados produce su complementaria exacta", () => {
    expect(ixMediaOf(["mobile"])).toBe("(min-width: 768px)");
    expect(ixMediaOf(["desktop"])).toBe("(max-width: 1023.98px)");
    expect(ixMediaOf(["tablet"])).toBe("(max-width: 767.98px),(min-width: 1024px)");
    expect(ixMediaOf(["mobile", "tablet"])).toBe("(min-width: 1024px)");
    expect(ixMediaOf(["tablet", "desktop"])).toBe("(max-width: 767.98px)");
    expect(ixMediaOf(["mobile", "desktop"])).toBe("(min-width: 768px) and (max-width: 1023.98px)");
    expect(ixMediaOf([])).toBeUndefined();
  });

  it("las REGLAS de una unidad apagada en móvil van bajo su @media; los keyframes no", () => {
    const page = compileIxPage([{ ...mk({ on: "load" }), off: ["mobile"] }]);
    expect(page.css).toContain("@media (min-width: 768px){");
    const kfAt = page.css.indexOf("@keyframes");
    const mediaAt = page.css.indexOf("@media (min-width: 768px)");
    expect(kfAt).toBeGreaterThan(-1);
    expect(kfAt).toBeLessThan(mediaAt);
  });

  it("`off` entra en el hash: el mismo cuerpo con y sin gating son unidades distintas", () => {
    const plain = compileIx(mk({ on: "load" }))!;
    const gated = compileIx({ ...mk({ on: "load" }), off: ["mobile"] })!;
    expect(plain.hash).not.toBe(gated.hash);
    expect(gated.media).toBe("(min-width: 768px)");
  });

  it("apagar los TRES dispositivos es «Quitar»: se ignora el gating y se avisa", () => {
    const u = compileIx({ ...mk({ on: "load" }), off: ["mobile", "tablet", "desktop"] })!;
    expect(u.media).toBeUndefined();
    expect(u.warnings.join(" ")).toContain("quitarla");
  });

  it("el gating es del BLOQUE aunque el cuerpo venga de un preajuste", () => {
    const ctx = { presets: SYS_IX_PRESETS };
    const u = compileIx({ v: 1, preset: "sys:fade-up", off: ["mobile"] }, ctx)!;
    expect(u.media).toBe("(min-width: 768px)");
  });
});

describe("honestidad: opciones que un camino no puede expresar AVISAN, nunca callan", () => {
  it("un disparador de scroll ignora dur/delay/repeat/alt — y lo dice", () => {
    const u = compileIx(mk({ on: "scrub" }, { dur: 900, delay: 100, repeat: 3, alt: true }))!;
    const w = u.warnings.join(" ");
    expect(w).toContain("`dur`");
    expect(w).toContain("`delay`");
    expect(w).toContain("`repeat`");
    expect(w).toContain("`alt`");
    // Y el CSS sigue siendo el de siempre: la opción no emitida no cambia ni un byte.
    expect(u.rules[0]).toContain("1ms linear both");
  });

  it("un scroll SIN esas opciones no gana ningún aviso nuevo", () => {
    expect(compileIx(mk({ on: "scrub" }))!.warnings).toHaveLength(0);
  });

  it("hover de 2 pasos (transición) ignora repeat/alt — y lo dice", () => {
    const u = compileIx(mk({ on: "hover" }, { repeat: "inf", alt: true }))!;
    expect(u.warnings.join(" ")).toContain("transición");
    expect(u.rules[0]).toContain("transition:");
  });

  it("hover de 3 pasos SÍ honra repeat/alt: sin aviso", () => {
    const u = compileIx(mk({ on: "hover" }, { steps: steps3, repeat: "inf", alt: true }))!;
    expect(u.warnings).toHaveLength(0);
    expect(u.rules[0]).toContain("infinite alternate");
  });
});

describe("varias pistas", () => {
  it("cada pista tiene su @keyframes numerado y su propia regla", () => {
    const u = compileIx({
      v: 1,
      trigger: { on: "load" },
      tracks: [
        { target: { kind: "self" }, steps: steps2 },
        { target: { kind: "children" }, steps: [{ at: 0, set: { y: 10 } }, { at: 100, set: { y: 0 } }] },
      ],
    })!;
    expect(u.keyframes).toHaveLength(2);
    expect(u.rules).toHaveLength(2);
    expect(u.rules[0]).toContain(`wjs-ixk-${u.hash}-0`);
    expect(u.rules[1]).toContain(`wjs-ixk-${u.hash}-1`);
    expect(u.rules[1].startsWith(`.${u.cls}>*{`)).toBe(true);
  });
});
