/**
 * C6 — EL GOLDEN DE LA HOJA: el CSS de una página, byte a byte.
 *
 * El resto de la batería comprueba PROPIEDADES ("emite `animation-timeline`", "no emite `infinite`
 * si no repite"). Ninguna veía la hoja ENTERA, así que un cambio de forma —una declaración de más
 * en cada regla, un orden distinto, un `@media` que se parte en dos— pasaba sin que nada se pusiera
 * rojo, y solo se notaba en los bytes que descarga el visitante.
 *
 * Este golden es deliberadamente pequeño y representativo: un `view` que entra y sale (camino
 * nativo), un `scrub` sobre los hijos anclado a una escena fija (C5) y un bucle perpetuo (C3, con
 * su token de pausa). Si cambia, el diff DEBE leerse: o es una mejora consciente y se actualiza, o
 * es una regresión que se acaba de cazar.
 *
 * Lo que este golden pin­cha, y por qué importa cada línea:
 *   · TODO vive dentro de `@media (prefers-reduced-motion:no-preference)` — la garantía absoluta;
 *   · el atajo `animation` va ANTES de `animation-timeline` (el atajo la resetearía);
 *   · las unidades nativas van bajo `@supports`, y el bucle NO (no necesita timeline);
 *   · el token de pausa aparece SOLO en el bucle;
 *   · el espejo RTL viaja como `calc(var(--wjs-ix-dir,1) * …)`, no horneado;
 *   · el escalonado NO emite retardos sobre una timeline de scroll (el progreso ya lo da la
 *     posición: desplazar por hermano no significaría nada) — igual que en el runtime;
 *   · la unidad de ESCENA solo existe DENTRO de una escena (`:where(.wjs-block-section--scene)`):
 *     fuera de ella, una timeline con nombre sin resolver congelaría el bloque en su fotograma 0.
 */
import { describe, expect, it } from "vitest";
import { compileIxPage } from "../compile";

const SPECS = [
  {
    v: 1,
    trigger: { on: "view", once: false },
    tracks: [
      {
        target: { kind: "self" },
        steps: [{ at: 0, set: { opacity: 0, y: 24 } }, { at: 100, set: { opacity: 1, y: 0 } }],
      },
    ],
  },
  {
    v: 1,
    trigger: { on: "scrub", src: "scene" },
    tracks: [
      {
        target: { kind: "children" },
        dur: 800,
        stagger: { each: 60 },
        steps: [{ at: 0, set: { opacity: 0, x: -40 } }, { at: 100, set: { opacity: 1, x: 0 } }],
      },
    ],
  },
  {
    v: 1,
    trigger: { on: "load" },
    tracks: [
      {
        target: { kind: "self" },
        repeat: "inf",
        alt: true,
        steps: [{ at: 0, set: { scale: 1 } }, { at: 100, set: { scale: 1.05 } }],
      },
    ],
  },
];

const GOLDEN = `@media screen and (prefers-reduced-motion:no-preference){
@keyframes wjs-ixk-1rv0lab{0%{transform:scale(1)}100%{transform:scale(1.05)}}
.wjs-ix-1rv0lab{animation:wjs-ixk-1rv0lab 600ms linear infinite alternate var(--wjs-ix-play,running) both}
@keyframes wjs-ixk-1kg2ymy{0%{opacity:0;transform:translate3d(calc(var(--wjs-ix-dir,1) * -40px),0px,0)}100%{opacity:1;transform:translate3d(0px,0px,0)}}
@supports (animation-timeline:view()){:where(.wjs-block-section--scene) .wjs-ix-1kg2ymy>*,.wjs-ix-1kg2ymy:where(.wjs-block-section--scene)>*{animation:wjs-ixk-1kg2ymy 1ms linear both;animation-timeline:--wjs-ix-scene;animation-range:contain 0% contain 100%}}
@keyframes wjs-ixk-1erxz71{0%{opacity:0;transform:translate3d(0px,24px,0)}100%{opacity:1;transform:translate3d(0px,0px,0)}}
@supports (animation-timeline:view()){.wjs-ix-1erxz71{animation:wjs-ixk-1erxz71 1ms linear both;animation-timeline:view();animation-range:entry 0% cover 40%}}
}
`;

describe("golden de la hoja emitida", () => {
  it("una página representativa emite EXACTAMENTE esta hoja", () => {
    expect(compileIxPage(SPECS)).toMatchObject({ css: GOLDEN });
  });

  it("y la emite igual dos veces seguidas: el compilador es determinista", () => {
    expect(compileIxPage(SPECS).css).toBe(compileIxPage(SPECS).css);
  });

  it("el orden de las specs de entrada NO cambia la hoja (se ordena por cuerpo canónico)", () => {
    const reversed = [...SPECS].reverse();
    expect(compileIxPage(reversed).css).toBe(GOLDEN);
  });

  it("son 940 bytes para tres interacciones — el presupuesto se mira, no se supone", () => {
    // Sin gzip y sin minificar: es lo que viaja dentro del HTML. Que el número esté escrito aquí es
    // lo que convierte "es poquísimo CSS" en una afirmación comprobable.
    expect(GOLDEN.length).toBe(940);
  });
});
