/**
 * Verso — interacciones: PRESETS DE SISTEMA (`sys:*`).
 *
 * Los 12 tipos de entrada y los 4 efectos de scroll que hoy viven como clases estáticas en
 * `backend/public/css/wordjs-ui.css` (secciones ENTRANCE ANIMATIONS y SCROLL-DRIVEN INTERACTIONS),
 * expresados en el modelo nuevo. Son de SOLO LECTURA y viven en el código, no en ajustes del sitio.
 *
 * ⚠ QUÉ NO SON: NO sustituyen a `anim`, no lo migran y no lo tocan. `anim` sigue produciendo
 * exactamente las mismas clases `wjs-anim-*` / `wjs-scroll-*` y el mismo CSS estático de siempre
 * (ver el test de no-ruptura). Reescribir `anim`→`ix` en las páginas guardadas cambiaría bytes de
 * `_puck_data` en cada una: rompería el gate de round-trip, invalidaría el caché de todas y
 * generaría una revisión por página, y el visitante NO vería ninguna diferencia. Coste alto,
 * beneficio cero. Estos presets existen para bloques NUEVOS y para el botón manual "Convertir a
 * interacción" (F9-D).
 *
 * ⚠ EQUIVALENCIA VISUAL: transcripción fiel de los `@keyframes` actuales, pero el CSS emitido NO es
 * byte-idéntico (aquí `translate3d(0, 28px, 0)` donde ui.css escribe `translateY(28px)`, y el
 * fotograma final es el valor neutro explícito donde ui.css escribe `transform: none`). Que el
 * RECORRIDO VISUAL coincida se verifica en navegador, comparando el computado en 5 puntos de la
 * animación — es el gate F9-B.5, y hasta que se pase no se puede afirmar que coincidan.
 *
 * Las intensidades de los presets de scroll van BAKEADAS al 30 (el defecto de `--wjs-scroll-amt`).
 * La intensidad por bloque es un escalar `--wjs-ixv-amt` y llega en F9-D.
 */
import type { IxPreset, IxStep, IxTrack } from "./types";

const DUR = 600;

/** Una pista de entrada estándar: sobre el propio bloque, con la curva `out` de ui.css. */
const entrance = (steps: IxStep[]): IxTrack[] => [
  { target: { kind: "self" }, steps, dur: DUR, delay: 0 },
];

const enter = (id: string, name: string, steps: IxStep[]): IxPreset => ({
  id: `sys:${id}`,
  name,
  trigger: { on: "view", once: true },
  tracks: entrance(steps),
  rev: 1,
});

const scroll = (id: string, name: string, steps: IxStep[]): IxPreset => ({
  id: `sys:${id}`,
  name,
  trigger: { on: "scrub", range: { from: { at: "cover", pct: 0 }, to: { at: "cover", pct: 100 } } },
  tracks: [{ target: { kind: "self" }, steps }],
  rev: 1,
});

/** Intensidad bakeada de los presets de scroll — el defecto de `--wjs-scroll-amt` en ui.css. */
const AMT = 30;

const SYS_LIST: IxPreset[] = [
  // ── Las 12 entradas ────────────────────────────────────────────────
  enter("fade", "Aparecer", [
    { at: 0, set: { opacity: 0 }, ease: "out" },
    { at: 100, set: { opacity: 1 } },
  ]),
  enter("fade-up", "Aparecer subiendo", [
    { at: 0, set: { opacity: 0, y: 28 }, ease: "out" },
    { at: 100, set: { opacity: 1, y: 0 } },
  ]),
  enter("fade-down", "Aparecer bajando", [
    { at: 0, set: { opacity: 0, y: -28 }, ease: "out" },
    { at: 100, set: { opacity: 1, y: 0 } },
  ]),
  enter("fade-left", "Aparecer desde la izquierda", [
    { at: 0, set: { opacity: 0, x: -32 }, ease: "out" },
    { at: 100, set: { opacity: 1, x: 0 } },
  ]),
  enter("fade-right", "Aparecer desde la derecha", [
    { at: 0, set: { opacity: 0, x: 32 }, ease: "out" },
    { at: 100, set: { opacity: 1, x: 0 } },
  ]),
  enter("zoom", "Acercar", [
    { at: 0, set: { opacity: 0, scale: 0.92 }, ease: "out" },
    { at: 100, set: { opacity: 1, scale: 1 } },
  ]),
  enter("zoom-out", "Alejar", [
    { at: 0, set: { opacity: 0, scale: 1.08 }, ease: "out" },
    { at: 100, set: { opacity: 1, scale: 1 } },
  ]),
  enter("blur", "Desenfocar", [
    { at: 0, set: { opacity: 0, blur: 12 }, ease: "out" },
    { at: 100, set: { opacity: 1, blur: 0 } },
  ]),
  enter("rise", "Emerger", [
    { at: 0, set: { opacity: 0, y: 64, scale: 0.98 }, ease: "out" },
    { at: 100, set: { opacity: 1, y: 0, scale: 1 } },
  ]),
  enter("flip", "Voltear", [
    { at: 0, set: { opacity: 0, rotateX: -70 }, ease: "out" },
    { at: 100, set: { opacity: 1, rotateX: 0 } },
  ]),
  // `reveal` descubre con un clip: el contenido nunca cambia de sitio (cero CLS) y no necesita
  // overflow:hidden en el padre. La opacidad se queda en 1 en los dos extremos, como en ui.css.
  enter("reveal", "Descubrir", [
    { at: 0, set: { opacity: 1, clip: 0 }, ease: "out" },
    { at: 100, set: { opacity: 1, clip: 100 } },
  ]),
  enter("swing", "Balancear", [
    { at: 0, set: { opacity: 0, rotate: -6, y: 18 }, ease: "out" },
    { at: 60, set: { opacity: 1, rotate: 2, y: 0 }, ease: "out" },
    { at: 100, set: { opacity: 1, rotate: 0, y: 0 } },
  ]),

  // ── Los 4 efectos de scroll ────────────────────────────────────────
  scroll("parallax", "Paralaje", [
    { at: 0, set: { y: AMT } },
    { at: 100, set: { y: -AMT } },
  ]),
  scroll("scroll-fade", "Fundido con el scroll", [
    { at: 0, set: { opacity: 1 - AMT / 100 } },
    { at: 35, set: { opacity: 1 } },
    { at: 65, set: { opacity: 1 } },
    { at: 100, set: { opacity: 1 - AMT / 100 } },
  ]),
  scroll("scroll-scale", "Escalar con el scroll", [
    { at: 0, set: { scale: 1 - AMT / 400 } },
    { at: 50, set: { scale: 1 } },
    { at: 100, set: { scale: 1 - AMT / 400 } },
  ]),
  scroll("scroll-rotate", "Girar con el scroll", [
    { at: 0, set: { rotate: AMT * -0.06 } },
    { at: 100, set: { rotate: AMT * 0.06 } },
  ]),

  // ── P7: la biblioteca curada — el escaparate de P2–P6 ──────────────
  // Físicas de P2 (compiladas a linear(): cero JS):
  enter("rebote", "Rebotar al entrar", [
    { at: 0, set: { opacity: 0, y: -60 }, ease: "bounce" },
    { at: 100, set: { opacity: 1, y: 0 } },
  ]),
  enter("elastico", "Entrada elástica", [
    { at: 0, set: { opacity: 0, scale: 0.7 }, ease: "elastic" },
    { at: 100, set: { opacity: 1, scale: 1 } },
  ]),
  // 3D y sesgo de P3:
  enter("volteo-3d", "Volteo 3D", [
    { at: 0, set: { opacity: 0, rotateY: -90 }, ease: "out" },
    { at: 100, set: { opacity: 1, rotateY: 0 } },
  ]),
  enter("sesgo", "Deslizar con sesgo", [
    { at: 0, set: { opacity: 0, x: -40, skewX: 8 }, ease: "out" },
    { at: 100, set: { opacity: 1, x: 0, skewX: 0 } },
  ]),
  // Escalonados de P4 sobre los HIJOS del bloque (cascada lineal y onda de rejilla):
  {
    id: "sys:tarjetas-cascada",
    name: "Tarjetas en cascada",
    trigger: { on: "view", once: true },
    tracks: [{
      target: { kind: "children" },
      steps: [
        { at: 0, set: { opacity: 0, y: 24 }, ease: "out" },
        { at: 100, set: { opacity: 1, y: 0 } },
      ],
      dur: DUR,
      stagger: { each: 80 },
    }],
    rev: 1,
  },
  {
    id: "sys:tarjetas-rejilla",
    name: "Tarjetas en rejilla",
    trigger: { on: "view", once: true },
    tracks: [{
      target: { kind: "children" },
      steps: [
        { at: 0, set: { opacity: 0, scale: 0.94 }, ease: "out" },
        { at: 100, set: { opacity: 1, scale: 1 } },
      ],
      dur: DUR,
      stagger: { each: 70, cols: 3 },
    }],
    rev: 1,
  },
  // Puntero de P6. El tilt compone los DOS ejes por ANIDAMIENTO (self + children): dos pistas
  // sobre el mismo elemento pelearían por `transform` (last-wins de la lista); los transform de
  // elementos anidados se multiplican, que es la composición de verdad.
  {
    id: "sys:tilt",
    name: "Tilt con el puntero",
    trigger: { on: "pointer" },
    tracks: [
      {
        target: { kind: "self" },
        steps: [{ at: 0, set: { rotateY: -8 } }, { at: 100, set: { rotateY: 8 } }],
      },
      {
        target: { kind: "children" },
        axis: "y",
        steps: [{ at: 0, set: { rotateX: 6 } }, { at: 100, set: { rotateX: -6 } }],
      },
    ],
    rev: 1,
  },
  {
    id: "sys:parallax-puntero",
    name: "Paralaje con el puntero",
    trigger: { on: "pointer", area: "page", smooth: 250 },
    tracks: [
      {
        target: { kind: "self" },
        steps: [{ at: 0, set: { x: -18 } }, { at: 100, set: { x: 18 } }],
      },
      {
        target: { kind: "children" },
        axis: "y",
        steps: [{ at: 0, set: { y: -12 } }, { at: 100, set: { y: 12 } }],
      },
    ],
    rev: 1,
  },
  // Scroll con lo nuevo de P3 (dirección de revelado; filtros de color):
  {
    id: "sys:scroll-revelado",
    name: "Revelado con el scroll",
    trigger: { on: "scrub", range: { from: { at: "entry", pct: 0 }, to: { at: "cover", pct: 50 } } },
    tracks: [{
      target: { kind: "self" },
      clipDir: "up",
      steps: [{ at: 0, set: { clip: 0 } }, { at: 100, set: { clip: 100 } }],
    }],
    rev: 1,
  },
  scroll("scroll-color", "Color con el scroll", [
    { at: 0, set: { grayscale: 100, saturate: 0.4 } },
    { at: 40, set: { grayscale: 0, saturate: 1 } },
    { at: 60, set: { grayscale: 0, saturate: 1 } },
    { at: 100, set: { grayscale: 100, saturate: 0.4 } },
  ]),
];

/** Catálogo indexado por id, congelado: un preset de sistema no se edita en caliente. */
export const SYS_IX_PRESETS: Readonly<Record<string, IxPreset>> = Object.freeze(
  Object.fromEntries(SYS_LIST.map((p) => [p.id, p])),
);

export const SYS_IX_PRESET_IDS: readonly string[] = Object.freeze(SYS_LIST.map((p) => p.id));
