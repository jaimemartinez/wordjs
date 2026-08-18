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
    ["puntero (parallax/tilt) — P6", mk({ on: "pointer" }), "always"],
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
    // El bucle INFINITO lleva además el token de pausa dentro del propio atajo (WCAG 2.2.2): el
    // control del visitante pone `--wjs-ix-play:paused` en la raíz y todos los bucles se detienen.
    // Una animación finita NO lo lleva — se comprueba en el pin de arriba, que sigue siendo exacto.
    expect(rep.rules[0]).toContain("600ms linear infinite alternate var(--wjs-ix-play,running) both");
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
    // 23 nth-child + 1 catch-all + 1 nativa (@supports sibling-index) + 1 regla principal (P5: los
    // grupos por objetivo se emiten tras el bucle, así que la principal va al final — el orden no
    // cambia la cascada: los selectores de escalonado ganan por especificidad, no por posición).
    expect(u.rules).toHaveLength(1 + IX_MAX_CHILDREN + 1);
    expect(u.rules[0]).toBe(`.${u.cls}>:nth-child(1){animation-delay:0ms}`);
    expect(u.rules[1]).toBe(`.${u.cls}>:nth-child(2){animation-delay:60ms}`);
    expect(u.rules[IX_MAX_CHILDREN - 2]).toBe(`.${u.cls}>:nth-child(23){animation-delay:1320ms}`);
    expect(u.rules[IX_MAX_CHILDREN - 1]).toBe(`.${u.cls}>:nth-child(n+24){animation-delay:1380ms}`);
    // La nativa: UNA regla, sin tope de hermanos, condicionada por su propia expresión, y con
    // selector `>:nth-child(n)` — misma especificidad que el fallback y posterior: gana el empate.
    expect(u.rules[IX_MAX_CHILDREN]).toBe(
      `@supports (animation-delay:calc((sibling-index() - 1) * 60ms + 0ms)){.${u.cls}>:nth-child(n){animation-delay:calc((sibling-index() - 1) * 60ms + 0ms)}}`,
    );
    expect(u.rules[IX_MAX_CHILDREN + 1]).toContain(`animation:wjs-ixk-${u.hash} 600ms linear both`);
  });

  it("P5: dos pistas sobre el MISMO objetivo componen UNA lista de animation (nada se pisa)", () => {
    const u = compileIx({
      v: 1,
      trigger: { on: "load" },
      tracks: [
        { target: { kind: "self" }, steps: steps2, repeat: "inf", alt: true },
        { target: { kind: "self" }, steps: [{ at: 0, set: { y: 30 } }, { at: 100, set: { y: 0 } }] },
      ],
    })!;
    const animRules = u.rules.filter((r) => r.includes("{animation:"));
    expect(animRules).toHaveLength(1);
    expect(animRules[0]).toBe(
      // La pista infinita lleva el token de pausa; la finita, de la misma lista, NO — el peaje se
      // paga exactamente donde la norma lo exige y en ningún sitio más.
      `.${u.cls}{animation:wjs-ixk-${u.hash}-0 600ms linear infinite alternate var(--wjs-ix-play,running) both,wjs-ixk-${u.hash}-1 600ms linear both}`,
    );
    // Y como tocan propiedades distintas (opacity vs y), no hay aviso de solape.
    expect(u.warnings).toHaveLength(0);
  });

  it("P5: dos pistas mismo objetivo tocando la MISMA propiedad avisan (manda la última)", () => {
    const u = compileIx({
      v: 1,
      trigger: { on: "load" },
      tracks: [
        { target: { kind: "self" }, steps: steps2 },
        { target: { kind: "self" }, steps: [{ at: 0, set: { opacity: 0.5 } }, { at: 100, set: { opacity: 1 } }] },
      ],
    })!;
    expect(u.warnings.join(" ")).toContain("misma propiedad");
  });

  it("P5: dos pistas scrub sobre el mismo objetivo comparten timeline y rango en UNA regla", () => {
    const u = compileIx({
      v: 1,
      trigger: { on: "scrub" },
      tracks: [
        { target: { kind: "self" }, steps: steps2 },
        { target: { kind: "self" }, steps: [{ at: 0, set: { y: 30 } }, { at: 100, set: { y: 0 } }] },
      ],
    })!;
    const supports = u.rules.filter((r) => r.startsWith("@supports"));
    expect(supports).toHaveLength(1);
    expect(supports[0]).toContain(
      `animation:wjs-ixk-${u.hash}-0 1ms linear both,wjs-ixk-${u.hash}-1 1ms linear both`,
    );
    // Una sola timeline y un solo rango: son del disparador y se difunden por la lista.
    expect(supports[0].slice(supports[0].indexOf("){")).match(/animation-timeline/g)).toHaveLength(1);
  });

  it("`from: center` nativo es EXACTO (abs + sibling-count) y el fallback cae a start avisando", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 50, from: "center" },
    }))!;
    expect(u.warnings.join(" ")).toContain("centro");
    expect(u.rules[0]).toContain(">:nth-child(1){");
    const native = u.rules.find((r) => r.startsWith("@supports (animation-delay"))!;
    expect(native).toContain("abs(sibling-index() - (sibling-count() + 1) / 2)");
  });

  it("modo TIEMPO TOTAL: nativo exacto con sibling-count; fallback reparte entre 8 y avisa", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 700, total: true },
    }))!;
    const native = u.rules.find((r) => r.startsWith("@supports (animation-delay"))!;
    expect(native).toContain("(700ms / max(1,sibling-count() - 1))");
    // Fallback: 700 / (8-1) = 100ms por hermano.
    expect(u.rules[1]).toBe(`.${u.cls}>:nth-child(2){animation-delay:100ms}`);
    expect(u.warnings.join(" ")).toContain("8 hermanos");
  });

  it("REJILLA: onda diagonal fila+columna con las columnas del autor; `from` se ignora avisando", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 80, cols: 3, from: "end" },
    }))!;
    const native = u.rules.find((r) => r.startsWith("@supports (animation-delay"))!;
    expect(native).toContain("round(down,(sibling-index() - 1) / 3)");
    expect(native).toContain("mod((sibling-index() - 1),3)");
    expect(u.warnings.join(" ")).toContain("diagonal");
    // El fallback de la rejilla es lineal por nth-child (nunca nth-last-child: `from` no aplica).
    expect(u.rules[0]).toContain(">:nth-child(1){");
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
    expect(u.rules[0]).toContain(">:nth-last-child(1){");
    expect(u.warnings).toHaveLength(0);
  });

  it("`from: center` no es expresable en CSS puro: avisa y cae a `start`", () => {
    const u = compileIx(mk({ on: "load" }, {
      target: { kind: "children" }, stagger: { each: 50, from: "center" },
    }))!;
    expect(u.warnings.join(" ")).toContain("centro");
    expect(u.rules[0]).toContain(">:nth-child(1){");
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

  it("P13: `from` en palabras es EXACTO con índice + recuento (final y centro)", () => {
    const end = compileIx(mk({ on: "load" }, {
      target: { kind: "words" }, stagger: { each: 40, from: "end" },
    }))!;
    expect(end.rules[0]).toContain(
      "animation-delay:calc((var(--wjs-ixv-n, 1) - 1 - var(--wjs-ixv-i, 0)) * 40ms + 0ms)",
    );
    const center = compileIx(mk({ on: "load" }, {
      target: { kind: "words" }, stagger: { each: 40, from: "center" },
    }))!;
    expect(center.rules[0]).toContain(
      "animation-delay:calc(abs(var(--wjs-ixv-i, 0) - (var(--wjs-ixv-n, 1) - 1) / 2) * 40ms + 0ms)",
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
    // `skewX` es DIRECCIONAL y lleva el token del espejo RTL (C4); `skewY` y el resto, no. Y el
    // valor CERO se emite limpio: un 0 no tiene lado que espejar y no paga el `calc`.
    expect(u.keyframes[0]).toContain(
      "transform:perspective(1000px) translate3d(0px,0px,-100px) scaleX(0.5) scaleY(1.5) rotateY(90deg) skewX(calc(var(--wjs-ix-dir,1) * 10deg)) skewY(-5deg)",
    );
    expect(u.keyframes[0]).toContain("skewX(0deg)");
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

describe("puntero (P6): sin CSS, con IR completo, y honestidad sobre lo que no aplica", () => {
  it("no emite ni una regla ni un @keyframes: la animación se POSICIONA, no se reproduce", () => {
    const u = compileIx(mk({ on: "pointer" }))!;
    expect(u.rules).toHaveLength(0);
    expect(u.keyframes).toHaveLength(0);
    expect(Object.keys(u.kf)).toHaveLength(1); // el IR WAAPI sí, para el driver
  });

  it("el manifiesto lleva area/smooth del disparador y el eje de la pista", () => {
    const u = compileIx({
      v: 1,
      trigger: { on: "pointer", area: "page", smooth: 300 },
      tracks: [{ target: { kind: "self" }, axis: "y", steps: steps2 }],
    })!;
    const r = toRuntimeUnit(u);
    expect(r.trigger).toEqual({ on: "pointer", area: "page", smooth: 300 });
    expect(r.tracks[0].axis).toBe("y");
  });

  it("el suavizado por DEFECTO (120) y el eje por defecto (x) se borran: ausencia = defecto", () => {
    const u = compileIx({
      v: 1,
      trigger: { on: "pointer", smooth: 120 },
      tracks: [{ target: { kind: "self" }, axis: "x", steps: steps2 }],
    })!;
    expect(u.body.trigger).toEqual({ on: "pointer" });
    expect("axis" in u.body.tracks[0]).toBe(false);
  });

  it("dur/delay/repeat/alt/escalonado no significan nada con el puntero: se AVISA", () => {
    const u = compileIx(mk({ on: "pointer" }, { dur: 900, repeat: 3, stagger: { each: 50 }, target: { kind: "children" } }))!;
    expect(u.warnings.join(" ")).toContain("POSICIONA");
  });
});

describe("política de movimiento del SITIO (C5) — la decisión está por encima del bloque", () => {
  const looping = mk({ on: "load" }, { repeat: "inf" });
  const plain = mk({ on: "view", once: false });

  it("`full` es lo de siempre, byte a byte (el defecto no puede costar nada)", () => {
    const base = compileIxPage([looping, plain]);
    expect(compileIxPage([looping, plain], { motion: "full" }).css).toBe(base.css);
    // Y un valor inventado del ajuste cae en el defecto, no en un modo intermedio inventado.
    expect(compileIxPage([looping, plain], { motion: "apagadísimo" as never }).css).toBe(base.css);
  });

  it("`off` no emite NADA: ni CSS, ni manifiesto de runtime, ni control de pausa", () => {
    const page = compileIxPage([looping, plain], { motion: "off" });
    expect(page.css).toBe("");
    expect(page.units).toHaveLength(0);
    expect(page.runtime).toHaveLength(0);
    expect(page.hasInfinite).toBe(false);
  });

  it("`calm` deja el bucle en UNA vuelta — y la deja en su fotograma final, no en el primero", () => {
    const page = compileIxPage([looping], { motion: "calm" });
    expect(page.css).not.toContain("infinite");
    // `both` es lo que hace que se quede en el fotograma final: el estado neutro del bloque.
    expect(page.css).toContain("both");
    expect(page.hasInfinite).toBe(false);
    // Y sin bucles no se paga el token de pausa: ya no hay nada perpetuo que pausar.
    expect(page.css).not.toContain("--wjs-ix-play");
  });

  it("`calm` no toca lo que ya era finito", () => {
    const finite = compileIxPage([plain]);
    expect(compileIxPage([plain], { motion: "calm" }).css).toBe(finite.css);
  });
});

describe("la ESCENA FIJA como fuente del scroll (C5)", () => {
  it("engancha la animación a la timeline CON NOMBRE que declara la sección", () => {
    const u = compileIx(mk({ on: "scrub", src: "scene" }))!;
    expect(u.rules[0]).toContain("animation-timeline:--wjs-ix-scene");
  });

  it("la regla SOLO existe dentro de una escena — o el bloque se quedaría INVISIBLE", () => {
    // Revert-red del peor defecto posible: una timeline con nombre que no resuelve no deja la
    // animación quieta al final, la deja sin resolver, y con `fill: both` el elemento se congela en
    // su PRIMER fotograma. Medido en el navegador antes del arreglo: `opacity: 0` para siempre.
    const u = compileIx(mk({ on: "scrub", src: "scene" }))!;
    expect(u.rules[0]).toContain(`:where(.wjs-block-section--scene) .${u.cls}`);
    // Y el caso de que la propia sección fija sea el bloque animado.
    expect(u.rules[0]).toContain(`.${u.cls}:where(.wjs-block-section--scene)`);
    // Nunca el selector desnudo, que es el que dejaba el bloque colgado fuera de una escena.
    expect(u.rules[0]).not.toMatch(new RegExp(`\{\.${u.cls}\{`));
  });

  it("el `:where()` no sube la especificidad: la cascada entre reglas del motor no se reordena", () => {
    const u = compileIx(mk({ on: "scrub", src: "scene" }))!;
    expect(u.rules[0]).not.toContain(`.wjs-block-section--scene .${u.cls}`.replace(":where", ""));
    expect(u.rules[0]).toContain(":where(.wjs-block-section--scene)");
  });

  it("el @supports pregunta por `view()`, no por el nombre (un nombre no describe soporte)", () => {
    // `@supports (animation-timeline: --x)` es cierto en cuanto el motor entiende la SINTAXIS, que
    // no es lo que hay que saber; `view()` sí distingue al motor que trae timelines de scroll.
    const u = compileIx(mk({ on: "scrub", src: "scene" }))!;
    expect(u.rules[0].startsWith("@supports (animation-timeline:view()){")).toBe(true);
  });

  it("su rango por defecto es el TIEMPO DEL PIN: `contain 0% contain 100%`", () => {
    const u = compileIx(mk({ on: "scrub", src: "scene" }))!;
    expect(u.rules[0]).toContain("animation-range:contain 0% contain 100%");
    // Y no el de un scrub normal, que empieza antes de que la sección tape la ventana.
    expect(compileIx(mk({ on: "scrub" }))!.rules[0]).toContain("animation-range:cover 0% cover 100%");
  });

  it("el rango del autor manda también aquí", () => {
    const u = compileIx(mk({
      on: "scrub",
      src: "scene",
      range: { from: { at: "contain", pct: 20 }, to: { at: "contain", pct: 60 } },
    }))!;
    expect(u.rules[0]).toContain("animation-range:contain 20% contain 60%");
  });

  it("sigue siendo camino nativo: paga runtime solo donde no hay timelines", () => {
    const u = compileIx(mk({ on: "scrub", src: "scene" }))!;
    expect(u.needsRuntime).toBe("no-native");
  });

  it("una fuente inventada se descarta y vuelve al recorrido del bloque", () => {
    const u = compileIx({
      v: 1,
      trigger: { on: "scrub", src: "--wjs-ix-scene); } body{display:none" },
      tracks: [{ target: { kind: "self" }, steps: steps2 }],
    } as unknown as IxSpec)!;
    expect(u.rules[0]).toContain("animation-timeline:view()");
    expect(u.rules.join("")).not.toContain("display:none");
  });
});

describe("colores tomados del TEMA (C4) — recolorear el sitio recolorea su movimiento", () => {
  const tinted = {
    steps: [
      { at: 0, set: { opacity: 0 } },
      { at: 100, set: { opacity: 1 }, tint: { textColor: "primary" } },
    ] as unknown as IxStep[],
  };

  it("un paso con token emite var(--wjs-color-…) en vez de un hex horneado", () => {
    const u = compileIx(mk({ on: "load" }, tinted))!;
    expect(u.keyframes[0]).toContain("color:var(--wjs-color-primary)");
    expect(u.keyframes[0]).not.toMatch(/color:#[0-9a-f]{6}/);
  });

  it("el token GANA al número cuando el paso trae los dos", () => {
    const both = compileIx(mk({ on: "load" }, {
      steps: [
        { at: 0, set: { opacity: 0 } },
        { at: 100, set: { opacity: 1, textColor: 0x123456 }, tint: { textColor: "accent" } },
      ] as unknown as IxStep[],
    }))!;
    expect(both.keyframes[0]).toContain("var(--wjs-color-accent)");
    expect(both.keyframes[0]).not.toContain("#123456");
  });

  it("un token declara la propiedad: una pista SOLO con token sí emite", () => {
    const only = compileIx(mk({ on: "load" }, {
      steps: [
        { at: 0, set: {}, tint: { bgColor: "danger" } },
        { at: 100, set: {}, tint: { bgColor: "success" } },
      ] as unknown as IxStep[],
    }))!;
    expect(only.keyframes[0]).toContain("background-color:var(--wjs-color-danger)");
    expect(only.keyframes[0]).toContain("background-color:var(--wjs-color-success)");
  });

  it("dato hostil: un token que no está en la lista cerrada NO llega a la hoja", () => {
    const hostile = compileIx({
      v: 1,
      trigger: { on: "load" },
      tracks: [
        {
          target: { kind: "self" },
          steps: [
            { at: 0, set: { opacity: 0 }, tint: { textColor: "primary); } body{display:none" } },
            { at: 100, set: { opacity: 1 }, tint: { textColor: "primary", nope: "x" } },
          ],
        },
      ],
    } as unknown as IxSpec)!;
    const css = hostile.keyframes.join("");
    expect(css).not.toContain("display:none");
    expect(css).not.toContain("body{");
    expect(hostile.keyframes[0]).toContain("color:var(--wjs-color-primary)");
    // El paso 0 se queda SIN token (el suyo era basura) y hereda el color natural del bloque:
    // degradación honesta, no un token inventado.
    expect(hostile.keyframes[0]).not.toMatch(/\{0%\{[^}]*color:/);
  });
});

describe("espejo RTL del movimiento (C4) — y su paridad entre los dos backends", () => {
  const pair = (a: Record<string, number>, b: Record<string, number>) =>
    [{ at: 0, set: a }, { at: 100, set: b }] as unknown as IxStep[];
  const slideIn = { steps: pair({ x: -40 }, { x: 0 }) };

  it("el CSS multiplica los valores direccionales por el token; el resto no se toca", () => {
    const u = compileIx(mk({ on: "load" }, slideIn))!;
    expect(u.keyframes[0]).toContain("translate3d(calc(var(--wjs-ix-dir,1) * -40px),0px,0)");
    // La Y no es direccional: se queda tal cual, sin `calc` ni token.
    const vertical = compileIx(mk({ on: "load" }, { steps: pair({ y: -40 }, { y: 0 }) }))!;
    expect(vertical.keyframes[0]).toContain("translate3d(0px,-40px,0)");
    expect(vertical.keyframes[0]).not.toContain("--wjs-ix-dir");
  });

  it("el manifiesto del runtime lleva el juego ESPEJADO, con números y sin var()", () => {
    const rt = toRuntimeUnit(compileIx(mk({ on: "load" }, slideIn))!);
    const track = rt.tracks[0];
    expect(track.kf[0].transform).toContain("translate3d(-40px,0px,0)");
    // `var()` dentro de un fotograma de `Element.animate()` NO se resuelve: si se colara, la
    // animación se caería en silencio justo en el navegador que depende del fallback.
    expect(JSON.stringify(track.kf)).not.toContain("var(");
    expect(track.kfRtl?.[0].transform).toContain("translate3d(40px,0px,0)");
    expect(JSON.stringify(track.kfRtl)).not.toContain("var(");
  });

  it("sin nada direccional NO viaja un juego duplicado (bytes por nada)", () => {
    const rt = toRuntimeUnit(compileIx(mk({ on: "load" }, { steps: pair({ y: 20 }, { y: 0 }) }))!);
    expect(rt.tracks[0].kfRtl).toBeUndefined();
    // Un `x: 0` tampoco cuenta: cero no tiene lado.
    const zero = toRuntimeUnit(compileIx(mk({ on: "load" }, { steps: pair({ x: 0, y: 20 }, { x: 0, y: 0 }) }))!);
    expect(zero.tracks[0].kfRtl).toBeUndefined();
  });

  it("los dos backends espejan LO MISMO: el signo invertido y nada más", () => {
    const rt = toRuntimeUnit(compileIx(mk({ on: "load" }, slideIn))!);
    const ltr = rt.tracks[0].kf.map((k) => k.transform);
    const rtl = rt.tracks[0].kfRtl!.map((k) => k.transform);
    expect(rtl).toEqual(ltr.map((t) => t!.replace("-40px", "40px")));
  });
});

describe("pausa del movimiento perpetuo (C3) — WCAG 2.2.2, nivel A", () => {
  it("el token de pausa aparece SOLO en los bucles infinitos", () => {
    const inf = compileIx(mk({ on: "load" }, { repeat: "inf" }))!;
    expect(inf.rules[0]).toContain("var(--wjs-ix-play,running)");
    // Finita y repetida 3 veces: se detiene sola, la norma no la nombra, no paga el token.
    const finite = compileIx(mk({ on: "load" }, { repeat: 3 }))!;
    expect(finite.rules[0]).not.toContain("--wjs-ix-play");
    expect(compileIx(mk({ on: "load" }))!.rules[0]).not.toContain("--wjs-ix-play");
  });

  it("la PÁGINA declara si tiene movimiento perpetuo — es lo que enciende el control", () => {
    const still = compileIxPage([mk({ on: "load" })]);
    expect(still.hasInfinite).toBe(false);
    const looping = compileIxPage([mk({ on: "load" }), mk({ on: "load" }, { repeat: "inf" })]);
    expect(looping.hasInfinite).toBe(true);
  });

  it("el token NO se declara en la hoja: sin él, el valor de reserva del var() ya es `running`", () => {
    const page = compileIxPage([mk({ on: "load" }, { repeat: "inf" })]);
    // Declararlo en `:root` obligaría a pelear especificidades para apagarlo; el contrato es que el
    // token solo EXISTE cuando alguien lo pone en `paused` (la regla `:has()` del framework).
    expect(page.css).not.toContain("--wjs-ix-play:");
    expect(page.css).toContain("var(--wjs-ix-play,running)");
  });
});

describe("trazo SVG (P12): draw → stroke-dashoffset bajo el contrato .wjs-ixd + pathLength=1", () => {
  const drawTrack = { target: { kind: "svg" as const }, steps: [
    { at: 0, set: { draw: 0 } }, { at: 100, set: { draw: 100 } },
  ] as unknown as IxStep[] };

  it("emite contra los descendientes .wjs-ixd, en 0..1 (pathLength=1), sin medir nada", () => {
    const u = compileIx(mk({ on: "view", once: false }, drawTrack))!;
    expect(u.rules[0]).toContain(` .wjs-ixd{`);
    expect(u.keyframes[0]).toContain("stroke-dashoffset:1");
    expect(u.keyframes[0]).toContain("stroke-dashoffset:0");
    expect(u.needsRuntime).toBe("no-native"); // el trazo con scroll sigue el camino nativo
  });

  it("la intensidad escala el trazado (es distancia recorrida) y el IR WAAPI lo lleva igual", () => {
    const u = compileIx({ v: 1, trigger: { on: "load" }, amt: 0.5, tracks: [drawTrack] })!;
    // draw 0 con amt 0.5 → 100+(0−100)×0.5 = 50 trazado → offset 0.5.
    expect(u.keyframes[0]).toContain("stroke-dashoffset:0.5");
    expect(Object.values(u.kf)[0][0].strokeDashoffset).toBe("0.5");
  });

  it("el runtime resuelve el objetivo svg por la clase del contrato", () => {
    const u = compileIx(mk({ on: "load" }, drawTrack))!;
    expect(toRuntimeUnit(u).tracks[0].target).toEqual({ kind: "svg" });
  });

  it("la intensidad SATURA el trazado en 0..100: el offset jamás sale de 0..1 ni invierte el trazo", () => {
    // Con amt 3, draw 0 escalaría a −200 → offset 3: sobre `stroke-dasharray: 1` el patrón DA LA
    // VUELTA y el trazo «oculto» se pinta entero. Saturado: offset 1 exacto, y el neutro sigue en 0.
    const u = compileIx({ v: 1, trigger: { on: "load" }, amt: 3, tracks: [drawTrack] })!;
    expect(u.keyframes[0]).toContain("stroke-dashoffset:1");
    expect(u.keyframes[0]).toContain("stroke-dashoffset:0");
    expect(u.keyframes[0]).not.toContain("stroke-dashoffset:3");
    // El IR WAAPI pasa por LA MISMA función: paridad byte a byte.
    expect(Object.values(u.kf)[0][0].strokeDashoffset).toBe("1");
  });

  it("`event` sobre un objetivo externo (`block`) se declara SIN SOPORTE, no como promesa de runtime", () => {
    // El bucket de eventos solo conmuta el atributo del propio bloque y el driver WAAPI no espera
    // eventos: decir «se resuelve por runtime» aquí sería mentir. Aviso propio y pista inerte.
    const u = compileIx({
      v: 1,
      trigger: { on: "event", name: "abrir" },
      tracks: [{ target: { kind: "block", id: "hero" }, steps: [
        { at: 0, set: { x: 0 } }, { at: 100, set: { x: 20 } },
      ] as unknown as IxStep[] }],
    })!;
    expect(u.rules).toHaveLength(0);
    expect(u.needsRuntime).toBe("always");
    expect(u.warnings.some((w) => w.includes("sin soporte"))).toBe(true);
    expect(u.warnings.some((w) => w.includes("se resuelve por runtime"))).toBe(false);
  });
});

describe("evento a medida (P11) y suavizado del scrub (P10)", () => {
  it("event → latch `always` contra [data-wjs-ix=on], como el clic", () => {
    const u = compileIx(mk({ on: "event", name: "abrir-menu" }))!;
    expect(u.needsRuntime).toBe("always");
    expect(u.rules[0].startsWith(`.${u.cls}[data-wjs-ix="on"]{`)).toBe(true);
  });

  it("un nombre que no es slug DESCARTA el disparador entero (fail-open al defecto)", () => {
    for (const bad of ["", "Mayus", "con espacios", "a".repeat(60), "wjs:ix:x", null, 7]) {
      const u = compileIx(mk({ on: "event", name: bad } as never))!;
      // normTrigger devuelve undefined → cae al disparador por defecto (view+once).
      expect(u.body.trigger).toEqual({ on: "view", once: true });
    }
  });

  it("scrub con `smooth` pasa a `always`, NO emite CSS, y AVISA del intercambio", () => {
    const u = compileIx(mk({ on: "scrub", smooth: 300 }))!;
    expect(u.needsRuntime).toBe("always");
    expect(u.rules).toHaveLength(0);
    expect(u.keyframes).toHaveLength(0);
    expect(Object.keys(u.kf)).toHaveLength(1);
    expect(u.warnings.join(" ")).toContain("compositor");
    // smooth: 0 = sin suavizado: el normalizador lo borra y vuelve el camino nativo.
    const plain = compileIx(mk({ on: "scrub", smooth: 0 }))!;
    expect(plain.needsRuntime).toBe("no-native");
    expect(plain.hash).toBe(compileIx(mk({ on: "scrub" }))!.hash);
  });
});

describe("intensidad (P7): del bloque, horneada, y solo sobre lo espacial", () => {
  const spatial = (amt?: number) => compileIx({
    v: 1,
    trigger: { on: "load" },
    ...(amt !== undefined ? { amt } : {}),
    tracks: [{ target: { kind: "self" }, steps: [
      { at: 0, set: { y: 24, opacity: 0, bgColor: 0xff0000 } },
      { at: 100, set: { y: 0, opacity: 1 } },
    ] }],
  })!;

  it("amt 0.5 escala la distancia al neutro de las espaciales; opacidad y color quedan intactos", () => {
    const u = spatial(0.5);
    expect(u.keyframes[0]).toContain("translate3d(0px,12px,0)");
    expect(u.keyframes[0]).toContain("opacity:0");
    expect(u.keyframes[0]).toContain("background-color:#ff0000");
  });

  it("la escala respeta el neutro de cada propiedad (scale 1, clip 100)", () => {
    const u = compileIx({
      v: 1, trigger: { on: "load" }, amt: 2,
      tracks: [{ target: { kind: "self" }, steps: [
        { at: 0, set: { scale: 0.9, clip: 60 } }, { at: 100, set: { scale: 1, clip: 100 } },
      ] }],
    })!;
    // scale: 1 + (0.9−1)×2 = 0.8; clip revelado 60 → 100+(60−100)×2 = 20 → recorte 80%.
    expect(u.keyframes[0]).toContain("scale(0.8)");
    expect(u.keyframes[0]).toContain("inset(0 80% 0 0)");
  });

  it("amt entra en el hash (unidades distintas) y amt 1 se borra (bytes de siempre)", () => {
    expect(spatial(0.5).hash).not.toBe(spatial().hash);
    expect(spatial(1).hash).toBe(spatial().hash);
    expect("amt" in spatial(1).body).toBe(false);
  });

  it("sobre un preset la intensidad es del BLOQUE: escala el cuerpo del preset sin tocarlo", () => {
    const ctx = { presets: SYS_IX_PRESETS };
    const strong = compileIx({ v: 1, preset: "sys:fade-up", amt: 2 }, ctx)!;
    const plain = compileIx({ v: 1, preset: "sys:fade-up" }, ctx)!;
    expect(plain.keyframes[0]).toContain("translate3d(0px,28px,0)");
    expect(strong.keyframes[0]).toContain("translate3d(0px,56px,0)");
    expect(strong.hash).not.toBe(plain.hash);
  });

  it("el IR WAAPI lleva la MISMA escala (paridad de backends)", () => {
    const u = spatial(0.5);
    expect(Object.values(u.kf)[0][0].transform).toContain("translate3d(0px,12px,0)");
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
