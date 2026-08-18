/**
 * Verso — interacciones: EL COMPILADOR (modelo → CSS nativo). Puro, sin dependencias, testeable en
 * node. Ni `"use client"` ni React ni DOM: exactamente el mismo código produce el CSS del canvas y
 * el del sitio público, así que la paridad de las dos superficies es por CONSTRUCCIÓN.
 *
 *   IxSpec (+presets) ──resolveIxBody──▶ IxBody ──emitUnit──┬──▶ rules/keyframes (backend CSS)
 *                                                            └──▶ kf: IxKeyframe[] (backend WAAPI)
 *
 * UN IR, DOS BACKENDS. El backend WAAPI no es trabajo extra del fallback: lo consumen el driver de
 * scrub (navegadores sin `animation-timeline`), el scrubber del panel y los tests de paridad (que
 * comparan recorridos SIN navegador). Ese es el motivo de que el IR exista.
 *
 * COMPOSICIÓN, RESUELTA EN COMPILACIÓN. Hoy `wordjs-ui.css` documenta que dos `animation` sobre el
 * mismo elemento pelean por `transform` y lo resuelve por decreto ("gana el scroll"). Aquí no hay
 * pelea: si un paso pone `x`, `y`, `scale` y `rotate`, se emite UNA declaración `transform` literal
 * con las cuatro. Se rechazó `animation-composition: add` (añade varianza entre motores justo donde
 * menos se tolera) y se rechazó animar variables `@property` (una custom property animada se
 * recalcula en el hilo principal y el `transform` que depende de ella deja de subir al compositor).
 *
 * PROPIEDADES EMITIDAS: SOLO `opacity`, `transform`, `filter` y `clip-path`. No por revisión de
 * código, sino porque `IxProps` (types.ts) es una lista cerrada de 8 escalares y este emisor no
 * tiene ninguna rama que escriba otra cosa.
 */
import { canonicalJson, ixHash, round4 } from "./canonical";
import {
  IX_DEFAULT_DELAY,
  IX_DEFAULT_DUR,
  IX_EASINGS,
  IX_MAX_CHILDREN,
  IX_MAX_UNITS_PER_PAGE,
  IX_PERSP_DEFAULT,
  IX_COLOR_PROP_KEYS,
  IX_PROP_KEYS,
  IX_PROP_NEUTRAL,
  IX_STAGGER_TOTAL_FALLBACK_N,
  normalizeIxSpec,
} from "./normalize";
import type {
  IxBody,
  IxBreakpoint,
  IxClipDir,
  IxColorPropKey,
  IxKeyframe,
  IxNeedsRuntime,
  IxOrigin,
  IxPage,
  IxPreset,
  IxProps,
  IxPropKey,
  IxRange,
  IxRuntimeTrack,
  IxRuntimeUnit,
  IxSpec,
  IxStagger,
  IxStep,
  IxTarget,
  IxTrack,
  IxTrigger,
  IxUnit,
} from "./types";

/* ------------------------------------------------------------------ */
/* Contexto                                                            */
/* ------------------------------------------------------------------ */

export type IxCompileCtx = {
  /** Presets del SITIO (ya normalizados con `normalizeIxPreset`) + los del sistema. */
  presets?: Readonly<Record<string, IxPreset>>;
  /**
   * POLÍTICA DE MOVIMIENTO DEL SITIO (C5). La decide quien administra, no cada bloque:
   *
   *   `full` — lo de siempre (y el defecto): la página emite exactamente lo que el autor puso.
   *   `calm` — el movimiento PERPETUO deja de serlo: cada bucle se reproduce una vez y se queda en
   *            su fotograma final, que por contrato del motor es el estado neutro del bloque. No se
   *            pausa en el fotograma 0 a propósito: un bucle que empieza invisible se quedaría
   *            invisible, y "tranquilo" no puede significar "roto".
   *   `off`  — la página no emite NI UNA regla de interacción ni un byte de runtime. Los bloques se
   *            ven en su estado natural, que es la misma degradación que ya tiene el visitante con
   *            `prefers-reduced-motion` o sin JavaScript.
   */
  motion?: IxMotionPolicy;
};

export type IxMotionPolicy = "full" | "calm" | "off";
export const IX_MOTION_POLICIES: readonly IxMotionPolicy[] = Object.freeze([
  "full",
  "calm",
  "off",
]);

/** Lo que llegue de la configuración es dato hostil: fuera de la lista cerrada, `full`. */
export function normalizeIxMotion(raw: unknown): IxMotionPolicy {
  return raw === "calm" || raw === "off" ? raw : "full";
}

/**
 * El cuerpo tal y como lo emite la política del sitio. Con `calm`, ninguna pista repite para
 * siempre — y como el cuerpo es LO QUE SE HASHEA, la clase y el CSS resultantes son los de una
 * interacción finita de verdad, no los de una infinita disfrazada.
 */
function applyMotionPolicy(body: IxBody, motion: IxMotionPolicy): IxBody {
  if (motion !== "calm") return body;
  if (!body.tracks.some((t) => t.repeat === "inf")) return body;
  return {
    ...body,
    tracks: body.tracks.map((t) => {
      if (t.repeat !== "inf") return t;
      const next = { ...t };
      delete next.repeat; // ausencia = 1, que es como se escribe "una vez" en este modelo
      return next;
    }),
  };
}

/**
 * Disparador por defecto cuando la interacción no declara uno. Es la entrada de hoy: aparecer al
 * entrar en pantalla, UNA vez. Explícito aquí y en ningún otro sitio.
 */
export const IX_DEFAULT_TRIGGER: IxTrigger = { on: "view", once: true };

/**
 * Rango por defecto de cada disparador ligado a scroll (§4.2 de la spec). Exportado para que el
 * panel pueda EDITAR "el rango que hay" cuando el autor aún no puso ninguno — la alternativa sería
 * duplicar estos valores en el modelo del panel y que un día divergieran.
 */
export const IX_DEFAULT_RANGES: Readonly<Record<"scrub" | "view" | "scene", IxRange>> =
  Object.freeze({
    scrub: { from: { at: "cover", pct: 0 }, to: { at: "cover", pct: 100 } },
    view: { from: { at: "entry", pct: 0 }, to: { at: "cover", pct: 40 } },
    // La ESCENA mide el tramo en que la sección TAPA la ventana entera — que es exactamente el
    // tiempo que su escenario pasa fijo. `cover` incluiría además la entrada y la salida, y el
    // movimiento empezaría antes de que el "pin" existiese.
    scene: { from: { at: "contain", pct: 0 }, to: { at: "contain", pct: 100 } },
  });
const DEFAULT_RANGE = IX_DEFAULT_RANGES;

/* ------------------------------------------------------------------ */
/* Resolución del cuerpo (preset por referencia)                       */
/* ------------------------------------------------------------------ */

export type IxResolved = { body: IxBody; warnings: string[] };

/**
 * `IxSpec` (dato del bloque) → `IxBody` (lo único que entra en el hash).
 *
 * Un bloque enlazado a un preset aporta como mucho su `trigger`; el cuerpo sale del preset y
 * `rev` entra en el body, así que editar el preset cambia el hash → cambia el nombre de la clase y
 * de los `@keyframes` → el navegador no puede servir CSS viejo. Y el diff de `_puck_data` es
 * literalmente vacío, porque el bloque solo guardaba un id.
 *
 * Referencia rota (preset borrado, o `v` desconocida) → `null`: el bloque se renderiza VISIBLE y
 * sin interacción. Fail-open.
 */
export function resolveIxBody(raw: unknown, ctx?: IxCompileCtx): IxResolved | null {
  const norm = normalizeIxSpec(raw);
  if (!norm) return null;
  const { spec } = norm;
  const warnings = [...norm.warnings];

  if (spec.preset) {
    const preset = ctx?.presets?.[spec.preset];
    if (!preset) {
      // No se avisa con un warning "de página": una referencia rota es un caso de datos, no un
      // error del autor en este bloque, y el panel lo señala aparte (recuento de usos).
      return null;
    }
    const body: IxBody = {
      trigger: spec.trigger ?? preset.trigger,
      tracks: preset.tracks,
      rev: preset.rev,
    };
    // El gating y la intensidad son del BLOQUE aunque el cuerpo venga del preset: dos bloques con
    // el mismo preajuste pueden desactivarse o intensificarse por separado (y por eso entran en el
    // hash: son unidades distintas).
    if (spec.off) body.off = spec.off;
    if (spec.amt !== undefined) body.amt = spec.amt;
    return { body: applyMotionPolicy(body, normalizeIxMotion(ctx?.motion)), warnings };
  }

  if (!spec.tracks || spec.tracks.length === 0) return null;
  const body: IxBody = { trigger: spec.trigger ?? IX_DEFAULT_TRIGGER, tracks: spec.tracks };
  if (spec.off) body.off = spec.off;
  if (spec.amt !== undefined) body.amt = spec.amt;
  return { body: applyMotionPolicy(body, normalizeIxMotion(ctx?.motion)), warnings };
}

/* ------------------------------------------------------------------ */
/* Gating responsive (P4)                                              */
/* ------------------------------------------------------------------ */

/** Los px de los breakpoints — LOS MISMOS que las clases `wjs-hide-*` de wordjs-ui.css. */
const BP_RANGES: Readonly<Record<IxBreakpoint, readonly [string | null, string | null]>> =
  Object.freeze({
    mobile: [null, "767.98px"],
    tablet: ["768px", "1023.98px"],
    desktop: ["1024px", null],
  });

/**
 * Condición `@media` que PERMITE los dispositivos no desactivados: los rangos permitidos contiguos
 * se funden, y varios tramos salen como lista separada por comas (una media query list). Texto
 * construido íntegramente por el compilador desde la lista cerrada — jamás del autor.
 */
export function ixMediaOf(off: readonly IxBreakpoint[]): string | undefined {
  if (off.length === 0) return undefined;
  const allowed = (["mobile", "tablet", "desktop"] as const).filter((b) => !off.includes(b));
  if (allowed.length === 0) return undefined; // el normalizador ya lo impide; cinturón
  // Fusionar tramos contiguos (mobile+tablet → [null, 1023.98px], etc.).
  const merged: Array<[string | null, string | null]> = [];
  for (const b of allowed) {
    const [min, max] = BP_RANGES[b];
    const last = merged[merged.length - 1];
    const contiguous =
      last &&
      ((b === "tablet" && last[1] === "767.98px") || (b === "desktop" && last[1] === "1023.98px"));
    if (contiguous) last[1] = max;
    else merged.push([min, max]);
  }
  return merged
    .map(([min, max]) => {
      if (min && max) return `(min-width: ${min}) and (max-width: ${max})`;
      if (min) return `(min-width: ${min})`;
      return `(max-width: ${max})`;
    })
    .join(",");
}

/* ------------------------------------------------------------------ */
/* Formato de valores — el ÚNICO camino de un número al CSS            */
/* ------------------------------------------------------------------ */

/** Un número, redondeado igual que el canónico, y NADA más. No admite cadenas por diseño. */
const n = (v: number): string => String(round4(v));

/**
 * La curva de UN paso, como texto CSS: el bezier PROPIO si lo hay (cuatro números clampados que
 * formatea este emisor — jamás una cadena del autor), y si no el nombre de la tabla cerrada.
 * `undefined` = el paso no declara curva.
 */
function easeCss(step: IxStep): string | undefined {
  if (step.bez) {
    const [x1, y1, x2, y2] = step.bez;
    return `cubic-bezier(${n(x1)},${n(y1)},${n(x2)},${n(y2)})`;
  }
  return step.ease ? IX_EASINGS[step.ease] : undefined;
}

/* ------------------------------------------------------------------ */
/* Un paso → declaraciones                                             */
/* ------------------------------------------------------------------ */

/**
 * Unión de propiedades tocadas por la pista, en el ORDEN CANÓNICO de IX_PROP_KEYS.
 *
 * Por qué la unión y no las claves de cada paso: si el paso 0 pone `y` y el paso 1 solo `opacity`,
 * emitir `transform` únicamente en el 0 haría que el navegador interpolase desde "sin transform"
 * (= neutro) igualmente, pero con `clip-path` y `filter` el resultado ya no es intuitivo y con
 * varios pasos intermedios deja de ser predecible. Rellenando la unión con el valor NEUTRO todos
 * los fotogramas declaran el mismo conjunto de propiedades: interpolación exacta y determinista.
 */
function unionProps(steps: IxStep[]): IxPropKey[] {
  const seen = new Set<IxPropKey>();
  for (const s of steps) {
    for (const k of IX_PROP_KEYS) if (s.set[k] !== undefined) seen.add(k);
    // Un color tomado del TEMA (C4) declara la propiedad igual que un número: sin esto, una pista
    // que solo usa tokens no aparecería en la unión y no se emitiría nada. Los colores están fuera
    // del relleno neutro, así que entrar en la unión no obliga a inventar valores en otros pasos.
    if (s.tint) for (const k of IX_COLOR_PROP_KEYS) if (s.tint[k]) seen.add(k);
  }
  return IX_PROP_KEYS.filter((k) => seen.has(k));
}

/**
 * Propiedades que la INTENSIDAD (P7) escala: las espaciales. La opacidad y los colores quedan
 * fuera — una intensidad de 0.5 debe suavizar el movimiento, no dejar el fundido a medias — y los
 * filtros de color (brillo/contraste/saturación/grises/tono) también: son apariencia, no recorrido.
 */
const IX_AMT_PROPS: ReadonlySet<IxPropKey> = new Set<IxPropKey>([
  "x", "y", "z", "scale", "scaleX", "scaleY", "rotate", "rotateX", "rotateY",
  "skewX", "skewY", "blur", "clip", "draw",
]);

const valOf = (set: IxProps, k: IxPropKey): number => set[k] ?? IX_PROP_NEUTRAL[k];

/** El valor con la intensidad horneada: neutro + (valor − neutro) × amt, solo en las espaciales. */
const scaledVal = (set: IxProps, k: IxPropKey, amt: number): number => {
  const v = valOf(set, k);
  if (amt === 1 || !IX_AMT_PROPS.has(k)) return v;
  return IX_PROP_NEUTRAL[k] + (v - IX_PROP_NEUTRAL[k]) * amt;
};

/**
 * `draw` → `stroke-dashoffset`, EL ÚNICO camino (CSS y WAAPI comparten esta función: paridad).
 * El escalado por intensidad se SATURA en 0..100 antes de convertir: con `amt` > 1 un `draw: 0`
 * escalaría a negativo y el offset saldría de 0..1 — y sobre `stroke-dasharray: 1` el patrón DA LA
 * VUELTA: el trazo «oculto» se pinta entero. La intensidad acerca o aleja del neutro; jamás puede
 * invertir la visibilidad del trazo.
 */
const drawOffset = (set: IxProps, ctx: TrackCssCtx): number =>
  (100 - Math.min(100, Math.max(0, scaledVal(set, "draw", ctx.amt)))) / 100;

/** Color 0xRRGGBB → `#rrggbb`. El emisor formatea; el autor jamás aporta la cadena. */
const hexColor = (v: number): string => `#${(Math.round(v) & 0xffffff).toString(16).padStart(6, "0")}`;

/**
 * El color de una propiedad en un paso: token del TEMA si lo declara, y si no el hex del número.
 * `undefined` = el paso no toca ese color, que es lo que hace que el navegador interpole desde el
 * color natural del bloque (los colores no participan del relleno neutro).
 *
 * El token GANA al número cuando están los dos: si el autor eligió un rol del tema, esa es su
 * intención, y el número que hubiera quedado detrás es historia de la edición.
 */
function colorOf(step: IxStep, key: IxColorPropKey): string | undefined {
  const tok = step.tint?.[key];
  if (tok) return `var(--wjs-color-${tok})`;
  const v = step.set[key];
  return v === undefined ? undefined : hexColor(v);
}

/**
 * Contexto de PISTA para emitir un estado: qué dirección recorta `clip`, con qué perspectiva se
 * emiten los 3D y qué `transform-origin` lleva la regla. Sale del normalizador, listas cerradas.
 */
type TrackCssCtx = { clipDir: IxClipDir; persp: number; amt: number };

/**
 * Cómo se emite un valor DIRECCIONAL (`x`, `skewX`) — el espejo RTL del motor (ciclo 3 · C4).
 *
 * El problema: «entra deslizando desde la izquierda» está horneado con signo fijo, así que en árabe
 * o hebreo el bloque entra por el lado equivocado y el movimiento va CONTRA la lectura. En un CMS
 * que importa sitios multilingües eso no es teoría.
 *
 *  · `css`   — el camino nativo multiplica por el token `--wjs-ix-dir` (1 en LTR, −1 en RTL, lo
 *              declara wordjs-ui.css). Una sola regla global espeja TODA la hoja, sin duplicar ni
 *              un `@keyframes` y sin que ninguna cadena del autor entre en el CSS.
 *  · `num`   — el backend WAAPI: valores numéricos, porque `var()` dentro de un fotograma de
 *              `Element.animate()` no se resuelve y la animación se caería en silencio.
 *  · `rtl`   — el MISMO backend con el signo ya invertido. El runtime elige entre los dos juegos
 *              mirando la dirección computada del elemento, así que Firefox y el resto de caminos
 *              con JS espejan igual que el CSS. La paridad es el contrato; no se rompe por esto.
 */
type IxDirMode = "css" | "num" | "rtl";

/** El token del signo. No se declara en `:root`: sin declarar, el `var()` ya vale 1. */
const IX_DIR_VAR = "--wjs-ix-dir";

/** Un valor direccional en la forma que toque, y SIN coste cuando vale cero (0 no tiene lado). */
function dirVal(value: number, unit: "px" | "deg", dir: IxDirMode): string {
  if (value === 0) return `0${unit}`;
  if (dir === "rtl") return `${n(-value)}${unit}`;
  if (dir === "num") return `${n(value)}${unit}`;
  return `calc(var(${IX_DIR_VAR},1) * ${n(value)}${unit})`;
}

const trackCtx = (track: IxTrack, amt: number): TrackCssCtx => ({
  clipDir: track.clipDir ?? "right",
  persp: track.persp ?? IX_PERSP_DEFAULT,
  amt,
});

/**
 * Una sola declaración `transform` con TODO lo que la pista toca, en orden fijo:
 * perspective → translate3d → scale → scaleX/Y → rotate → rotateX/Y → skewX/Y.
 * `perspective()` va dentro del propio transform (no como propiedad `perspective` en el padre):
 * así la unidad es autocontenida y no depende de que algún ancestro coopere.
 */
function transformOf(
  set: IxProps,
  union: IxPropKey[],
  ctx: TrackCssCtx,
  dir: IxDirMode = "css",
): string | undefined {
  const has = (k: IxPropKey) => union.includes(k);
  const parts: string[] = [];
  if (has("rotateX") || has("rotateY") || has("z")) parts.push(`perspective(${n(ctx.persp)}px)`);
  if (has("x") || has("y") || has("z")) {
    parts.push(
      `translate3d(${dirVal(scaledVal(set, "x", ctx.amt), "px", dir)},${n(scaledVal(set, "y", ctx.amt))}px,${has("z") ? `${n(scaledVal(set, "z", ctx.amt))}px` : "0"})`,
    );
  }
  if (has("scale")) parts.push(`scale(${n(scaledVal(set, "scale", ctx.amt))})`);
  if (has("scaleX")) parts.push(`scaleX(${n(scaledVal(set, "scaleX", ctx.amt))})`);
  if (has("scaleY")) parts.push(`scaleY(${n(scaledVal(set, "scaleY", ctx.amt))})`);
  if (has("rotate")) parts.push(`rotate(${n(scaledVal(set, "rotate", ctx.amt))}deg)`);
  if (has("rotateX")) parts.push(`rotateX(${n(scaledVal(set, "rotateX", ctx.amt))}deg)`);
  if (has("rotateY")) parts.push(`rotateY(${n(scaledVal(set, "rotateY", ctx.amt))}deg)`);
  if (has("skewX")) parts.push(`skewX(${dirVal(scaledVal(set, "skewX", ctx.amt), "deg", dir)})`);
  if (has("skewY")) parts.push(`skewY(${n(scaledVal(set, "skewY", ctx.amt))}deg)`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** La lista `filter` con lo que la pista toca, en orden canónico. blur va primero: era el único. */
function filterOf(set: IxProps, union: IxPropKey[], ctx: TrackCssCtx): string | undefined {
  const has = (k: IxPropKey) => union.includes(k);
  const parts: string[] = [];
  if (has("blur")) parts.push(`blur(${n(scaledVal(set, "blur", ctx.amt))}px)`);
  if (has("brightness")) parts.push(`brightness(${n(scaledVal(set, "brightness", ctx.amt))})`);
  if (has("contrast")) parts.push(`contrast(${n(scaledVal(set, "contrast", ctx.amt))})`);
  if (has("saturate")) parts.push(`saturate(${n(scaledVal(set, "saturate", ctx.amt))})`);
  if (has("grayscale")) parts.push(`grayscale(${n(scaledVal(set, "grayscale", ctx.amt))}%)`);
  if (has("hue")) parts.push(`hue-rotate(${n(scaledVal(set, "hue", ctx.amt))}deg)`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** `clip` es % REVELADO (100 = entero); la dirección dice qué borde(s) recorta el resto. */
function clipCss(revealed: number, dir: IxClipDir): string {
  const cut = n(100 - revealed);
  const half = n((100 - revealed) / 2);
  switch (dir) {
    case "right":
      return `inset(0 ${cut}% 0 0)`;
    case "left":
      return `inset(0 0 0 ${cut}%)`;
    case "up":
      return `inset(${cut}% 0 0 0)`;
    case "down":
      return `inset(0 0 ${cut}% 0)`;
    case "center-h":
      return `inset(0 ${half}% 0 ${half}%)`;
    case "center-v":
      return `inset(${half}% 0 ${half}% 0)`;
  }
}

/**
 * Declaraciones CSS de un estado (`prop: valor`, sin `;`), en orden canónico.
 *
 * Los COLORES no participan del relleno neutro: se emiten solo en los pasos que los declaran, y el
 * navegador interpola desde el estilo computado del bloque — "desde su color natural", que es lo
 * que el autor pidió y lo único que el compilador no puede conocer.
 */
function declsOf(step: IxStep, union: IxPropKey[], ctx: TrackCssCtx): string[] {
  const set = step.set;
  const out: string[] = [];
  if (union.includes("opacity")) out.push(`opacity:${n(scaledVal(set, "opacity", ctx.amt))}`);
  const tf = transformOf(set, union, ctx);
  if (tf) out.push(`transform:${tf}`);
  const fl = filterOf(set, union, ctx);
  if (fl) out.push(`filter:${fl}`);
  if (union.includes("clip")) out.push(`clip-path:${clipCss(scaledVal(set, "clip", ctx.amt), ctx.clipDir)}`);
  if (union.includes("draw")) {
    out.push(`stroke-dashoffset:${n(drawOffset(set, ctx))}`);
  }
  const text = colorOf(step, "textColor");
  if (text) out.push(`color:${text}`);
  const bg = colorOf(step, "bgColor");
  if (bg) out.push(`background-color:${bg}`);
  const border = colorOf(step, "borderColor");
  if (border) out.push(`border-color:${border}`);
  return out;
}

const TRANSFORM_KEYS: readonly IxPropKey[] = Object.freeze([
  "x", "y", "z", "scale", "scaleX", "scaleY", "rotate", "rotateX", "rotateY", "skewX", "skewY",
]);
const FILTER_KEYS: readonly IxPropKey[] = Object.freeze([
  "blur", "brightness", "contrast", "saturate", "grayscale", "hue",
]);

/** Las propiedades CSS que la pista toca — para `transition-property`. */
function transitionProps(union: IxPropKey[]): string[] {
  const out: string[] = [];
  if (union.includes("opacity")) out.push("opacity");
  if (union.some((k) => TRANSFORM_KEYS.includes(k))) out.push("transform");
  if (union.some((k) => FILTER_KEYS.includes(k))) out.push("filter");
  if (union.includes("clip")) out.push("clip-path");
  if (union.includes("draw")) out.push("stroke-dashoffset");
  if (union.includes("textColor")) out.push("color");
  if (union.includes("bgColor")) out.push("background-color");
  if (union.includes("borderColor")) out.push("border-color");
  return out;
}

/** El mismo estado, en forma WAAPI (backend 2 del IR). */
function keyframeOf(
  step: IxStep,
  union: IxPropKey[],
  ctx: TrackCssCtx,
  dir: IxDirMode = "num",
): IxKeyframe {
  const kf: IxKeyframe = { offset: round4(step.at / 100) };
  const ease = easeCss(step);
  if (ease) kf.easing = ease;
  if (union.includes("opacity")) kf.opacity = n(scaledVal(step.set, "opacity", ctx.amt));
  // WAAPI SIEMPRE numérico: un `var()` dentro de un fotograma de `Element.animate()` no se resuelve
  // y la animación se caería sin decir nada. El espejo RTL viaja como un JUEGO APARTE de fotogramas.
  const tf = transformOf(step.set, union, ctx, dir);
  if (tf) kf.transform = tf;
  const fl = filterOf(step.set, union, ctx);
  if (fl) kf.filter = fl;
  if (union.includes("clip")) kf.clipPath = clipCss(scaledVal(step.set, "clip", ctx.amt), ctx.clipDir);
  if (union.includes("draw")) {
    kf.strokeDashoffset = n(drawOffset(step.set, ctx));
  }
  // Los colores salen por el MISMO decisor que el CSS (token del tema o hex): dos caminos que
  // eligieran por su cuenta acabarían discrepando, y el previsualizador enseñaría otra cosa.
  const text = colorOf(step, "textColor");
  if (text) kf.color = text;
  const bg = colorOf(step, "bgColor");
  if (bg) kf.backgroundColor = bg;
  const border = colorOf(step, "borderColor");
  if (border) kf.borderColor = border;
  return kf;
}

/* ------------------------------------------------------------------ */
/* Selectores                                                          */
/* ------------------------------------------------------------------ */

/**
 * Sufijo del selector según el objetivo. `block` no tiene: un objetivo externo exigiría
 * `timeline-scope` (que Firefox no implementa y cuyo valor `all` solo tiene Safari), así que en
 * F9-A/B se resuelve SIEMPRE por runtime y no emite CSS.
 */
function targetSuffix(target: IxTarget): string | null {
  switch (target.kind) {
    case "self":
      return "";
    case "children":
      return ">*";
    case "words":
      return " .wjs-ixw";
    case "svg":
      // P12 — los trazos del bloque: paths que cumplen el contrato .wjs-ixd + pathLength=1.
      return " .wjs-ixd";
    case "block":
      return null;
  }
}

/**
 * Selector(es) base según el disparador: dónde "engancha" la animación.
 *
 * `view+once` y `click` NO son expresables en CSS puro (no existe un latch: `view()` retrocede al
 * subir, y `:target`/el checkbox-hack exigirían cambiar el markup, lo que rompe la restricción de
 * que canvas y público salgan del mismo código). Su CSS se escribe contra un atributo `data-wjs-ix`
 * que pone el runtime — el MISMO patrón que ya usa `data-wjs-anim` para la entrada de hoy.
 */
function stateSelectors(cls: string, trigger: IxTrigger): string[] {
  switch (trigger.on) {
    case "view":
      return trigger.once === false ? [`.${cls}`] : [`.${cls}[data-wjs-ix="in"]`];
    case "click":
    case "event":
      // El evento a medida (P11) es un latch como el clic: el JS pone `on`, el CSS reacciona.
      return [`.${cls}[data-wjs-ix="on"]`];
    case "hover":
      // `:focus-visible` acompaña siempre a `:hover`: una interacción que solo existe para el ratón
      // es una interacción que no existe para quien navega con teclado.
      return [`.${cls}:hover`, `.${cls}:focus-visible`];
    case "scrub":
    case "load":
    case "pointer":
      return [`.${cls}`];
  }
}

const joinSel = (bases: string[], suffix: string): string =>
  bases.map((b) => b + suffix).join(",");

/**
 * El texto sale COMPACTO (sin sangrías ni espacios de cortesía) porque es salida de PRODUCCIÓN:
 * viaja en el `<style>` de cada página y cuenta contra el presupuesto de bytes de §7.3. La
 * legibilidad se recupera con `ixKeyframes()` y con el IR, que es donde se depura de verdad.
 * Compacto no es menos determinista: no hay una sola decisión de formato que dependa del entorno.
 */
const rule = (selector: string, decls: string[]): string => `${selector}{${decls.join(";")}}`;

/**
 * Atajo `animation` en vez de las siete longhand: ~55 bytes por regla en lugar de ~220, y sin
 * ambigüedad (el nombre siempre empieza por `wjs-ixk-`, que no es palabra clave de ninguna de las
 * partes). Las partes que valen su valor inicial se OMITEN.
 *
 * ⚠ El atajo `animation` resetea `animation-timeline` a `auto`, así que en el camino de scroll
 * tiene que ir ANTES de `animation-timeline`/`animation-range`. Ese orden se respeta abajo.
 */
function animShorthand(
  name: string,
  dur: number,
  delay: string,
  repeat: number | "inf",
  alt: boolean,
): string {
  const parts = [name, `${n(dur)}ms`, "linear"];
  const wantsDelay = delay !== "0ms";
  if (wantsDelay) parts.push(delay);
  if (repeat !== 1) parts.push(repeat === "inf" ? "infinite" : n(repeat));
  if (alt) parts.push("alternate");
  // MOVIMIENTO PERPETUO → el visitante tiene que poder pararlo (WCAG 2.2.2, nivel A: pausar, parar
  // u ocultar todo lo que se mueva solo más de cinco segundos). El estado de reproducción es parte
  // legítima del atajo `animation`, así que la pausa cuesta UN TOKEN y cero JavaScript: el control
  // del pie del sitio pone `--wjs-ix-play: paused` en la raíz y todos los bucles se detienen a la
  // vez. Solo se emite donde hace falta: una animación finita no lleva ni un byte de más.
  if (repeat === "inf") parts.push("var(--wjs-ix-play,running)");
  parts.push("both");
  // Devuelve el VALOR (sin `animation:`): desde P5 las pistas de un mismo objetivo se unen en una
  // lista, y el nombre de la propiedad lo pone quien compone la declaración.
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Clasificación                                                       */
/* ------------------------------------------------------------------ */

const RUNTIME_RANK: Record<IxNeedsRuntime, number> = { never: 0, "no-native": 1, always: 2 };

const worseRuntime = (a: IxNeedsRuntime, b: IxNeedsRuntime): IxNeedsRuntime =>
  RUNTIME_RANK[a] >= RUNTIME_RANK[b] ? a : b;

/**
 * ¿El disparador conduce el progreso con una timeline de scroll NATIVA (y no con el tiempo)?
 * Un scrub CON suavizado (P10) no cuenta: su progreso lo persigue el runtime, no la timeline.
 */
const isTimeline = (t: IxTrigger): boolean =>
  (t.on === "scrub" && t.smooth === undefined) || (t.on === "view" && t.once === false);

function triggerRuntime(t: IxTrigger): IxNeedsRuntime {
  switch (t.on) {
    case "scrub":
      // Con suavizado (P10) no hay camino nativo: la persecución es del runtime, como el puntero.
      return t.smooth !== undefined ? "always" : "no-native";
    case "view":
      // once:false lo hace el CSS donde hay `animation-timeline`; once:true necesita un LATCH, y
      // en CSS no existe ninguno — este es el hallazgo que justifica conservar el
      // IntersectionObserver de `entranceAnimation.ts` tal cual.
      return t.once === false ? "no-native" : "always";
    case "click":
      return "always";
    case "event":
      // Latch por evento del documento (P11): JS por definición.
      return "always";
    case "pointer":
      // El cursor es inexpresable en CSS: el driver WAAPI, siempre — y SOLO si la página lo usa.
      return "always";
    case "hover":
    case "load":
      return "never";
  }
}

function rangeOf(t: IxTrigger): IxRange {
  if (t.on === "scrub") return t.range ?? DEFAULT_RANGE[t.src === "scene" ? "scene" : "scrub"];
  if (t.on === "view") return t.range ?? DEFAULT_RANGE.view;
  return DEFAULT_RANGE.view;
}

/** El nombre de la timeline de vista que declara una ESCENA FIJA en `wordjs-ui.css` (C5). */
export const IX_SCENE_TIMELINE = "--wjs-ix-scene";

/**
 * QUÉ conduce el progreso: el scroll del documento (`scroll()`), la escena fija que contiene al
 * bloque (la timeline CON NOMBRE que declara la sección, y que sus descendientes ven por herencia
 * del árbol) o el recorrido del propio bloque por la ventana (`view()`, el defecto).
 */
const timelineFn = (t: IxTrigger): string =>
  t.on !== "scrub"
    ? "view()"
    : t.src === "page"
      ? "scroll()"
      : t.src === "scene"
        ? IX_SCENE_TIMELINE
        : "view()";

const rangeCss = (r: IxRange): string =>
  `${r.from.at} ${n(r.from.pct)}% ${r.to.at} ${n(r.to.pct)}%`;

/**
 * Rango para una timeline de SCROLL (`scroll()`). Los nombres `cover`/`entry`/… son vocabulario de
 * las timelines de VISTA y no están definidos para el scroll del documento: emitirlos aquí dejaría
 * el comportamiento en manos de cómo cada motor trate un nombre inaplicable. Se emiten solo los
 * porcentajes — que es lo único que significa algo sobre el recorrido total — y si son 0/100 no se
 * emite nada, porque ese ES el valor inicial de `animation-range`.
 */
const pageRangeCss = (r: IxRange): string | null =>
  r.from.pct === 0 && r.to.pct === 100 ? null : `${n(r.from.pct)}% ${n(r.to.pct)}%`;

/* ------------------------------------------------------------------ */
/* Emisión de una unidad                                               */
/* ------------------------------------------------------------------ */

export const IX_CLASS_PREFIX = "wjs-ix-";
export const IX_KEYFRAME_PREFIX = "wjs-ixk-";
/** Recuento de palabras del split (P13); lo estampa el renderer junto al índice. */
export const IX_WORD_COUNT_VAR = "--wjs-ixv-n";

/** `transform-origin` de cada nombre de la lista cerrada (P3). El emisor pone el texto, nadie más. */
const ORIGIN_CSS: Readonly<Record<IxOrigin, string>> = Object.freeze({
  center: "50% 50%",
  top: "50% 0%",
  bottom: "50% 100%",
  left: "0% 50%",
  right: "100% 50%",
  "top-left": "0% 0%",
  "top-right": "100% 0%",
  "bottom-left": "0% 100%",
  "bottom-right": "100% 100%",
});
/** Índice del hermano dentro del stagger por palabras; la estampa el renderer del split (F9-D). */
export const IX_WORD_INDEX_VAR = "--wjs-ixv-i";

/**
 * Cuerpo normalizado + hash final → la unidad emitida.
 *
 * El hash se pasa DESDE FUERA porque la resolución de colisiones es competencia de la página
 * (`compileIxPage`): dos cuerpos distintos que reclamen el mismo hash tienen que poder
 * desambiguarse, y eso solo se sabe cuando se ven todos los cuerpos de la página.
 */
export function emitUnit(body: IxBody, hash: string): IxUnit {
  const cls = IX_CLASS_PREFIX + hash;
  const trigger = body.trigger;
  const rules: string[] = [];
  const keyframes: string[] = [];
  const kf: Record<string, IxKeyframe[]> = {};
  const warnings: string[] = [];
  let needsRuntime: IxNeedsRuntime = triggerRuntime(trigger);

  const bases = stateSelectors(cls, trigger);
  const multi = body.tracks.length > 1;

  /**
   * Agrupación POR SELECTOR (P5). Dos pistas sobre el MISMO objetivo no pueden emitir dos reglas
   * `animation:` sobre el mismo selector — la segunda PISARÍA a la primera (lo cazó el drill de
   * navegador: el computado solo corría la última). CSS compone animaciones como LISTA en una única
   * declaración, así que las pistas se acumulan por sufijo de objetivo y se emiten juntas. Con una
   * sola pista por objetivo la emisión es BYTE-IDÉNTICA a la de siempre. `animation-timeline` y
   * `animation-range` salen del DISPARADOR (común a la unidad), y una longhand más corta que la
   * lista de nombres se repite por especificación: un solo valor sirve para todas las pistas.
   * Si dos pistas del mismo objetivo tocan la misma propiedad (p. ej. transform), manda la última
   * de la lista — el mismo criterio last-wins de CSS, y se AVISA.
   */
  type TemporalPart = { name: string; dur: number; delayCss: string; repeat: number | "inf"; alt: boolean };
  const temporalGroups = new Map<string, TemporalPart[]>();
  const timelineGroups = new Map<string, string[]>();
  const armedGroups = new Map<string, string[]>();
  const seenHoverSuffix = new Set<string>();
  const seenStaggerSuffix = new Set<string>();
  const touchedBySuffix = new Map<string, Set<string>>();

  // El solape se mide por PROPIEDAD CSS, no por clave del modelo: `rotateX` y `rotateY` son claves
  // distintas pero comparten `transform`, y en una lista de animaciones la última se lleva el
  // transform ENTERO. Para componer ejes/familias sobre el mismo bloque: pistas `self`+`children`
  // (los transform anidados sí se multiplican), como hace el preset de tilt.
  const cssPropOf = (k: IxPropKey): string =>
    TRANSFORM_KEYS.includes(k)
      ? "transform"
      : FILTER_KEYS.includes(k)
        ? "filter"
        : k === "clip"
          ? "clip-path"
          : k; // opacity y los colores: propiedad propia por clave
  const noteOverlap = (suffix: string, union: IxPropKey[]) => {
    const props = new Set(union.map(cssPropOf));
    const seen = touchedBySuffix.get(suffix);
    if (!seen) {
      touchedBySuffix.set(suffix, props);
      return;
    }
    if ([...props].some((p) => seen.has(p))) {
      warnings.push(
        "dos pistas sobre el mismo objetivo compiten por la misma propiedad CSS: manda la última (usa `self`+`children` para componer transform por anidamiento)",
      );
    }
    for (const p of props) seen.add(p);
  };

  body.tracks.forEach((track, i) => {
    const union = unionProps(track.steps);
    const tcx = trackCtx(track, body.amt ?? 1);
    const name = `${IX_KEYFRAME_PREFIX}${hash}${multi ? `-${i}` : ""}`;
    kf[name] = track.steps.map((s) => keyframeOf(s, union, tcx));

    // El escalonado desplaza HERMANOS: sobre `self` o sobre otro bloque no hay hermanos que
    // desplazar. Hoy eso se ignoraba en silencio — se avisa, como todo lo que no se emite.
    // ANTES del `return` del objetivo externo: también a él le aplica.
    if (
      track.stagger &&
      track.stagger.each > 0 &&
      (track.target.kind === "self" || track.target.kind === "block")
    ) {
      warnings.push(
        "el escalonado necesita un objetivo con hermanos (`children`) o palabras (`words`): se ignora",
      );
    }

    const suffix = targetSuffix(track.target);
    if (suffix === null && trigger.on === "event") {
      // `event`+`block` NO está soportado (P11): el bucket de eventos del runtime solo conmuta el
      // atributo de estado del propio bloque y nunca resuelve objetivos externos, y el driver WAAPI
      // no sabe esperar a un evento. Decir «se resuelve por runtime» aquí sería una promesa rota:
      // se avisa como límite declarado, y la pista queda inerte A SABIENDAS del autor.
      needsRuntime = worseRuntime(needsRuntime, "always");
      warnings.push(
        "objetivo externo (`block`) con disparador `event`: combinación sin soporte — la pista no anima",
      );
      return;
    }
    if (suffix === null) {
      // Objetivo externo: sin CSS, resuelto por runtime. La unidad entera pasa a "always".
      needsRuntime = worseRuntime(needsRuntime, "always");
      warnings.push("objetivo externo (`block`): se resuelve por runtime, sin CSS (F9-A/B)");
      return;
    }

    /* ── P10: scrub con suavizado — el runtime PERSIGUE el progreso; sin CSS ── */
    if (trigger.on === "scrub" && trigger.smooth !== undefined) {
      warnings.push(
        "suavizado del scroll: el efecto pasa a JS (persecución) y renuncia al camino nativo del compositor — quita el suavizado para volver a la exactitud 1:1",
      );
      return;
    }

    /* ── P6: el puntero no emite CSS — la animación se POSICIONA con el cursor ─ */
    if (trigger.on === "pointer") {
      const ignored: string[] = [];
      if (track.dur !== undefined) ignored.push("`dur`");
      if (track.delay !== undefined) ignored.push("`delay`");
      if (track.repeat !== undefined) ignored.push("`repeat`");
      if (track.alt === true) ignored.push("`alt`");
      if (track.stagger && track.stagger.each > 0) ignored.push("el escalonado");
      if (ignored.length > 0) {
        warnings.push(
          `el puntero POSICIONA la animación (no la reproduce): ${ignored.join(", ")} se ignoran — la sensación se ajusta con el suavizado`,
        );
      }
      return;
    }

    const dur = track.dur ?? IX_DEFAULT_DUR;
    const loadDelay = trigger.on === "load" ? (trigger.delay ?? 0) : 0;
    const delay = (track.delay ?? IX_DEFAULT_DELAY) + loadDelay;
    const sel = joinSel(bases, suffix);

    // `transform-origin` (P3): una regla propia, SIN estado y fuera de cualquier @supports — tiene
    // que regir también cuando la animación la conduce el runtime de WAAPI en Firefox.
    if (track.origin) {
      rules.push(rule(`.${cls}${suffix}`, [`transform-origin:${ORIGIN_CSS[track.origin]}`]));
    }

    /* ── Camino 1: transición de hover con 2 pasos ──────────────────── */
    if (trigger.on === "hover" && track.steps.length === 2) {
      const [a, b] = track.steps;
      const props = transitionProps(union);
      const ease = easeCss(a) ?? IX_EASINGS.out;
      // Una transición no puede repetirse ni alternar: si el autor lo pidió, que lo sepa.
      if (track.repeat !== undefined || track.alt === true) {
        warnings.push(
          "una interacción de hover con 2 pasos es una transición: `repeat` y `alt` se ignoran (añade un paso intermedio para animarla)",
        );
      }
      if (seenHoverSuffix.has(suffix)) {
        warnings.push(
          "dos transiciones de hover sobre el mismo objetivo: manda la última (júntalas en una pista)",
        );
      }
      seenHoverSuffix.add(suffix);
      rules.push(
        rule(`.${cls}${suffix}`, [
          `transition:${props.map((p) => `${p} ${n(dur)}ms ${ease} ${n(delay)}ms`).join(",")}`,
          ...declsOf(a, union, tcx),
        ]),
      );
      rules.push(rule(sel, declsOf(b, union, tcx)));
      rules.push(...staggerRules(cls, track, trigger, suffix, delay, "transition-delay", warnings));
      if (track.target.kind === "words" && track.stagger && track.stagger.each > 0) {
        // El `calc()` por palabra solo existe en la vía de animación; una transición no tiene
        // dónde colgarlo sin una regla por palabra. Se avisa en vez de fingir que funciona.
        warnings.push(
          "el escalonado por palabras necesita 3 pasos o más (con 2 la interacción es una transición)",
        );
      }
      return;
    }

    /* ── Camino 2: progreso ligado al scroll (CSS puro donde lo haya) ─ */
    if (isTimeline(trigger)) {
      keyframes.push(keyframesCss(name, track.steps, union, tcx));
      noteOverlap(suffix, union);
      const list = timelineGroups.get(suffix);
      if (list) list.push(name);
      else timelineGroups.set(suffix, [name]);
      if (track.stagger && track.stagger.each > 0) {
        warnings.push(
          "el escalonado no aplica a un disparador de scroll: el progreso ya lo marca la posición",
        );
      }
      // Un disparador de scroll no tiene reloj: estas opciones no significan nada aquí y fingir
      // que sí sería mentir en silencio — la misma honestidad que ya se aplica al escalonado.
      const ignored: string[] = [];
      if (track.dur !== undefined) ignored.push("`dur`");
      if (track.delay !== undefined) ignored.push("`delay`");
      if (track.repeat !== undefined) ignored.push("`repeat`");
      if (track.alt === true) ignored.push("`alt`");
      if (ignored.length > 0) {
        warnings.push(
          `un disparador de scroll ignora ${ignored.join(", ")}: el progreso lo marca la posición, no el reloj`,
        );
      }
      return;
    }

    /* ── Camino 3: animación temporal (load / click / hover ≥3 / view+once) ─ */
    keyframes.push(keyframesCss(name, track.steps, union, tcx));
    noteOverlap(suffix, union);
    const part: TemporalPart = {
      name,
      dur,
      delayCss: wordsDelay(track, delay),
      repeat: track.repeat ?? 1,
      alt: track.alt === true,
    };
    const parts = temporalGroups.get(suffix);
    if (parts) parts.push(part);
    else temporalGroups.set(suffix, [part]);

    // El estado ARMADO de una entrada `once`: el fotograma 0, congelado, bajo un atributo que solo
    // pone el JS. El HTML servido NUNCA lo lleva, así que ni los rastreadores ni un visitante sin
    // JS ven jamás contenido oculto (§7.1 — cero CLS, cero FOUC, nada que tapar). Se ACUMULA por
    // objetivo: dos pistas arman el mismo elemento con UNA regla (y last-wins si chocan, como la
    // lista de animaciones).
    if (trigger.on === "view" && trigger.once !== false) {
      const armed = declsOf(track.steps[0], union, tcx);
      if (armed.length > 0) {
        const acc = armedGroups.get(suffix);
        if (acc) acc.push(...armed);
        else armedGroups.set(suffix, [...armed]);
      }
    }

    if (track.stagger && track.stagger.each > 0 && track.target.kind === "children") {
      if (seenStaggerSuffix.has(suffix)) {
        warnings.push(
          "dos pistas escalonan a los mismos hermanos: manda el escalonado de la última",
        );
      }
      seenStaggerSuffix.add(suffix);
    }
    rules.push(...staggerRules(cls, track, trigger, suffix, delay, "animation-delay", warnings));
  });

  /* ── Emisión de los grupos por objetivo (P5) ──────────────────────── */
  // El easing POR PASO se emite dentro de los @keyframes; el de elemento se fija `linear` para
  // que no compita con él y el resultado sea el mismo en los dos backends. Un `calc()` dentro del
  // atajo es válido pero frágil: cuando algún retardo es calculado (escalonado por palabras), TODOS
  // los retardos del grupo salen a la longhand `animation-delay`, alineados con la lista.
  for (const [suffix, parts] of temporalGroups) {
    const sel = joinSel(bases, suffix);
    const anyCalc = parts.some((p) => p.delayCss.startsWith("calc("));
    const shorthands = parts.map((p) =>
      animShorthand(p.name, p.dur, anyCalc ? "0ms" : p.delayCss, p.repeat, p.alt),
    );
    const decls = [`animation:${shorthands.join(",")}`];
    if (anyCalc) decls.push(`animation-delay:${parts.map((p) => p.delayCss).join(",")}`);
    rules.push(rule(sel, decls));
  }
  for (const [suffix, names] of timelineGroups) {
    const sel = joinSel(bases, suffix);
    const fn = timelineFn(trigger);
    const isPage = fn === "scroll()";
    // Una timeline con NOMBRE no se puede probar con `@supports (animation-timeline: --x)` de forma
    // significativa (la consulta valida la sintaxis, no que la escena exista), así que el @supports
    // pregunta por la forma genérica que sí describe el soporte del motor.
    const supportsFn = fn === IX_SCENE_TIMELINE ? "view()" : fn;
    const pageRange = isPage ? pageRangeCss(rangeOf(trigger)) : null;
    const decls = [
      // Duración dummy de 1ms: el progreso lo conduce la timeline, no el reloj. El atajo va
      // PRIMERO porque resetea `animation-timeline`. La timeline y el rango son del DISPARADOR:
      // un solo valor se repite por especificación sobre toda la lista de animaciones.
      `animation:${names.map((nm) => `${nm} 1ms linear both`).join(",")}`,
      `animation-timeline:${fn}`,
      ...(isPage
        ? pageRange
          ? [`animation-range:${pageRange}`]
          : []
        : [`animation-range:${rangeCss(rangeOf(trigger))}`]),
    ];
    rules.push(`@supports (animation-timeline:${supportsFn}){${rule(sel, decls)}}`);
  }
  for (const [suffix, decls] of armedGroups) {
    rules.push(rule(`.${cls}[data-wjs-ix="armed"]${suffix}`, decls));
  }

  const unit: IxUnit = { hash, cls, body, rules, keyframes, kf, needsRuntime, warnings };
  const media = body.off ? ixMediaOf(body.off) : undefined;
  if (media) unit.media = media;
  return unit;
}

/**
 * Escalonado por palabras: el índice viaja como variable inline en cada `<span class="wjs-ixw">`
 * (lo estampa el renderer del split, el MISMO en canvas y público), así que una sola regla sirve
 * para las 40. `--wjs-ixv-i` lleva el prefijo del MOTOR (`--wjs-ixv-*`), no el de las clases
 * (`--wjs-ix-*`), y queda excluido del manifiesto de tokens de tema: no es una costura skinable.
 */
function wordsDelay(track: IxTrack, delay: number): string {
  if (track.target.kind === "words" && track.stagger && track.stagger.each > 0) {
    const each = n(track.stagger.each);
    const d = n(delay);
    const i = `var(${IX_WORD_INDEX_VAR}, 0)`;
    const cnt = `var(${IX_WORD_COUNT_VAR}, 1)`;
    // P13 — con índice Y recuento en cada span, los tres órdenes son exactos también en palabras.
    switch (track.stagger.from ?? "start") {
      case "end":
        return `calc((${cnt} - 1 - ${i}) * ${each}ms + ${d}ms)`;
      case "center":
        return `calc(abs(${i} - (${cnt} - 1) / 2) * ${each}ms + ${d}ms)`;
      case "start":
        return `calc(${i} * ${each}ms + ${d}ms)`;
    }
  }
  return `${n(delay)}ms`;
}

/**
 * El retardo NATIVO de un hermano, como expresión `calc()` sobre `sibling-index()` /
 * `sibling-count()` (P4). Devuelve `null` si el modo no tiene expresión (no ocurre hoy: todos la
 * tienen). La expresión sirve además de CONDICIÓN del `@supports`: si el motor la parsea, la
 * soporta — no hace falta una tabla de features por navegador.
 */
function nativeStaggerExpr(st: IxStagger, baseDelay: number): string {
  const d = `${n(baseDelay)}ms`;
  if (st.cols !== undefined) {
    // Rejilla: onda diagonal fila+columna. El autor declara las columnas; el índice hace el resto.
    const i = "(sibling-index() - 1)";
    return `calc((round(down,${i} / ${n(st.cols)}) + mod(${i},${n(st.cols)})) * ${n(st.each)}ms + ${d})`;
  }
  if (st.total === true) {
    // Tiempo TOTAL repartido entre el primero y el último. max() evita dividir por cero con 1 hijo.
    return `calc((sibling-index() - 1) * (${n(st.each)}ms / max(1,sibling-count() - 1)) + ${d})`;
  }
  switch (st.from ?? "start") {
    case "end":
      return `calc((sibling-count() - sibling-index()) * ${n(st.each)}ms + ${d})`;
    case "center":
      return `calc(abs(sibling-index() - (sibling-count() + 1) / 2) * ${n(st.each)}ms + ${d})`;
    case "start":
      return `calc((sibling-index() - 1) * ${n(st.each)}ms + ${d})`;
  }
}

/**
 * Reglas del escalonado sobre hijos DIRECTOS: fallback `:nth-child()` + camino NATIVO.
 *
 * El fallback es el de siempre — `from: "end"` con `:nth-last-child()` (exacto sin contar),
 * `center` degradado a `start`, tope de IX_MAX_CHILDREN reglas con el 24.º compartido. ENCIMA se
 * emite UNA regla con `sibling-index()` dentro de un `@supports` cuya condición es la propia
 * expresión: donde el motor la entiende (Chrome 138+, Safari 26.2+, Firefox 154+), una regla
 * sustituye a veinticuatro, no hay tope de hermanos, y `center`, el tiempo total y la rejilla son
 * EXACTOS. El selector del camino nativo es `>:nth-child(n)` a propósito: misma especificidad
 * (0,2,0) que las reglas del fallback y posterior en la hoja — gana el empate donde aplica.
 */
function staggerRules(
  cls: string,
  track: IxTrack,
  trigger: IxTrigger,
  suffix: string,
  baseDelay: number,
  prop: "animation-delay" | "transition-delay",
  warnings: string[],
): string[] {
  const st = track.stagger;
  if (!st || st.each <= 0 || track.target.kind !== "children") return [];

  let from = st.from ?? "start";
  const grid = st.cols !== undefined;
  const total = st.total === true;
  if (grid && st.from) {
    warnings.push("la rejilla escalona en diagonal (fila + columna): `from` se ignora con `cols`");
  }
  if (from === "center" && !grid && !total) {
    warnings.push(
      "escalonado desde el centro: exacto donde hay `sibling-index()` (Chrome/Safari/Firefox 154+); en los demás cae a `start`",
    );
    from = "start";
  }
  // Fallback por hermano: la rejilla cae a lineal, y el tiempo total se reparte SUPONIENDO
  // IX_STAGGER_TOTAL_FALLBACK_N hermanos (contar exige `sibling-count()`). Ambos avisan.
  let fallbackEach = st.each;
  if (total) {
    fallbackEach = st.each / (IX_STAGGER_TOTAL_FALLBACK_N - 1);
    warnings.push(
      `tiempo total: exacto donde hay \`sibling-count()\`; el fallback reparte como si hubiera ${IX_STAGGER_TOTAL_FALLBACK_N} hermanos`,
    );
  }
  if (grid) {
    warnings.push("rejilla: exacta donde hay `sibling-index()`; en los demás cae a un escalonado lineal");
  }

  const nth = from === "end" && !grid && !total ? "nth-last-child" : "nth-child";
  const bases = stateSelectors(cls, trigger);
  // El camino de hover con 2 pasos escalona el estado BASE (la transición vive en `.cls`),
  // no el estado `:hover`; el resto escalona el selector del disparador.
  const prefixes = prop === "transition-delay" ? [`.${cls}`] : bases;
  const out: string[] = [];

  for (let k = 1; k < IX_MAX_CHILDREN; k++) {
    const d = baseDelay + (k - 1) * fallbackEach;
    out.push(rule(joinSel(prefixes, `>:${nth}(${k})`), [`${prop}:${n(d)}ms`]));
  }
  const last = baseDelay + (IX_MAX_CHILDREN - 1) * fallbackEach;
  out.push(rule(joinSel(prefixes, `>:${nth}(n+${IX_MAX_CHILDREN})`), [`${prop}:${n(last)}ms`]));

  const expr = nativeStaggerExpr(st, baseDelay);
  out.push(
    `@supports (${prop}:${expr}){${rule(joinSel(prefixes, ">:nth-child(n)"), [`${prop}:${expr}`])}}`,
  );
  // `suffix` es siempre " > *" en esta rama (target `children`); se acepta como parámetro para que
  // la firma no mienta y para que un cambio futuro de sufijo no pase desapercibido.
  void suffix;
  return out;
}

function keyframesCss(name: string, steps: IxStep[], union: IxPropKey[], ctx: TrackCssCtx): string {
  const body = steps
    .map((s) => {
      const decls: string[] = [];
      // El easing de un paso vale HASTA EL SIGUIENTE; en el último no significa nada y se omite.
      const ease = s.at < 100 ? easeCss(s) : undefined;
      if (ease) decls.push(`animation-timing-function:${ease}`);
      decls.push(...declsOf(s, union, ctx));
      return `${n(s.at)}%{${decls.join(";")}}`;
    })
    .join("");
  return `@keyframes ${name}{${body}}`;
}

/* ------------------------------------------------------------------ */
/* API de bloque                                                       */
/* ------------------------------------------------------------------ */

/**
 * Compila la prop `ix` de UN bloque, sin contexto de página. El hash es el "desnudo": la
 * desambiguación por colisión la hace `compileIxPage`, que es quien ve todos los cuerpos.
 */
export function compileIx(raw: unknown, ctx?: IxCompileCtx): IxUnit | null {
  const resolved = resolveIxBody(raw, ctx);
  if (!resolved) return null;
  const unit = emitUnit(resolved.body, ixHash(resolved.body));
  return { ...unit, warnings: [...resolved.warnings, ...unit.warnings] };
}

/* ------------------------------------------------------------------ */
/* API de página                                                       */
/* ------------------------------------------------------------------ */

/**
 * Separador del sufijo de colisión. `__` NO puede aparecer en un hash base36, así que
 * `wjs-ixk-<hash>__1` (unidad desambiguada, 1 pista) jamás se confunde con `wjs-ixk-<hash>-1`
 * (pista 1 de una unidad con varias). Un guion simple sí habría colisionado.
 */
const COLLIDE_SEP = "__";

/**
 * Compila TODAS las interacciones de una página: deduplica por cuerpo, resuelve colisiones de hash
 * y emite el texto CSS y el manifiesto del runtime.
 *
 * N bloques con el mismo preset comparten UNA clase y UN `@keyframes` — por eso el coste de CSS es
 * sublineal en el número de bloques.
 *
 * El orden de salida es el JSON canónico de los cuerpos, ordenado: NO el orden de aparición de los
 * bloques. Así, mover un bloque dentro de la página no cambia un byte del CSS emitido.
 */
export function compileIxPage(rawSpecs: readonly unknown[], ctx?: IxCompileCtx): IxPage {
  const warnings: string[] = [];
  const byKey = new Map<string, { body: IxBody; warnings: string[] }>();

  // El sitio con el movimiento APAGADO no compila nada: ni una regla, ni el manifiesto del runtime,
  // ni la etiqueta <style>. Filtrar más abajo dejaría la página pagando bytes por no moverse.
  if (normalizeIxMotion(ctx?.motion) === "off") {
    return { css: "", units: [], runtime: [], classByBody: new Map(), warnings: [], hasInfinite: false };
  }

  for (const raw of rawSpecs) {
    const resolved = resolveIxBody(raw, ctx);
    if (!resolved) continue;
    const key = canonicalJson(resolved.body);
    if (!byKey.has(key)) byKey.set(key, { body: resolved.body, warnings: resolved.warnings });
  }

  let keys = [...byKey.keys()].sort();
  if (keys.length > IX_MAX_UNITS_PER_PAGE) {
    warnings.push(
      `${keys.length} interacciones distintas en la página: se emiten ${IX_MAX_UNITS_PER_PAGE} (tope IX_MAX_UNITS_PER_PAGE)`,
    );
    keys = keys.slice(0, IX_MAX_UNITS_PER_PAGE);
  }

  // Colisiones: mismo hash, cuerpos distintos. Los cuerpos ya vienen ordenados por su JSON
  // canónico, así que el sufijo es determinista y estable entre ejecuciones y entre procesos.
  const byHash = new Map<string, string[]>();
  for (const key of keys) {
    const h = ixHash(byKey.get(key)!.body);
    const list = byHash.get(h);
    if (list) list.push(key);
    else byHash.set(h, [key]);
  }
  const finalHash = new Map<string, string>();
  for (const [h, list] of byHash) {
    if (list.length > 1) {
      warnings.push(`colisión de hash ${h} entre ${list.length} interacciones: se desambigua`);
    }
    list.forEach((key, i) => finalHash.set(key, i === 0 ? h : `${h}${COLLIDE_SEP}${i}`));
  }

  const units: IxUnit[] = [];
  const classByBody = new Map<string, string>();
  for (const key of keys) {
    const entry = byKey.get(key)!;
    const unit = emitUnit(entry.body, finalHash.get(key)!);
    units.push({ ...unit, warnings: [...entry.warnings, ...unit.warnings] });
    classByBody.set(key, unit.cls);
  }
  for (const u of units) for (const w of u.warnings) if (!warnings.includes(w)) warnings.push(w);

  return {
    units,
    css: ixCss(units),
    runtime: units.filter((u) => u.needsRuntime !== "never").map(toRuntimeUnit),
    classByBody,
    warnings,
    // Movimiento PERPETUO en la página: decide si el renderer ofrece al visitante el control para
    // pararlo (WCAG 2.2.2, nivel A). Se mira el cuerpo compilado, no la prop cruda: un preajuste
    // del sitio con bucle cuenta igual que un cuerpo propio, que es justo lo que ve el visitante.
    hasInfinite: units.some((u) => u.body.tracks.some((t) => t.repeat === "inf")),
  };
}

/**
 * La clase final de un bloque dentro de una página ya compilada. Se pasa por el cuerpo (no por el
 * bloque) para que dos bloques con el mismo movimiento den la misma clase, vengan de un preset o
 * de un cuerpo desvinculado idéntico.
 */
export function ixClassFor(raw: unknown, page: IxPage, ctx?: IxCompileCtx): string | null {
  const resolved = resolveIxBody(raw, ctx);
  if (!resolved) return null;
  return page.classByBody.get(canonicalJson(resolved.body)) ?? null;
}

/* ------------------------------------------------------------------ */
/* Emisión del texto CSS                                               */
/* ------------------------------------------------------------------ */

/**
 * Texto CSS de un conjunto de unidades.
 *
 * TODO va dentro de `@media (prefers-reduced-motion: no-preference)`: la primera de las tres capas
 * del contrato de accesibilidad (las otras dos son el bloque estático con `!important` en
 * `wordjs-ui.css` y la comprobación de la media query en el runtime). No hay override por bloque
 * ni por sitio: una preferencia del sistema operativo no es una casilla que el autor desmarque.
 *
 * `@keyframes` dentro de un `@media` es CSS válido (la regla condicional admite @keyframes en su
 * cuerpo) y mantiene TODO el motor bajo la misma guarda: nada puede quedarse fuera por descuido.
 */
export function ixCss(units: readonly IxUnit[]): string {
  const blocks: string[] = [];
  for (const u of units) {
    blocks.push(...u.keyframes);
    if (u.media && u.rules.length > 0) {
      // Gating responsive (P4): las REGLAS de la unidad, bajo su @media. Los @keyframes quedan
      // fuera — sin regla que los use no aplican, y así no se anidan tres niveles de condición.
      blocks.push(`@media ${u.media}{\n${u.rules.join("\n")}\n}`);
    } else {
      blocks.push(...u.rules);
    }
  }
  if (blocks.length === 0) return "";
  // Un salto de línea por bloque: no cuesta casi nada y hace que un `git diff` del CSS emitido sea
  // legible línea a línea en vez de un único renglón de 8 KB.
  return `@media screen and (prefers-reduced-motion:no-preference){\n${blocks.join("\n")}\n}\n`;
}

/** Backend WAAPI del IR: nombre → fotogramas. Lo consumen el driver de scrub y el scrubber. */
export function ixKeyframes(unit: IxUnit): Record<string, IxKeyframe[]> {
  return unit.kf;
}

/* ------------------------------------------------------------------ */
/* Manifiesto del runtime                                              */
/* ------------------------------------------------------------------ */

function toRuntimeTrack(track: IxTrack, trigger: IxTrigger, amt: number): IxRuntimeTrack {
  const union = unionProps(track.steps);
  const loadDelay = trigger.on === "load" ? (trigger.delay ?? 0) : 0;
  const ctx = trackCtx(track, amt);
  // El juego RTL solo viaja si la pista tiene algo DIRECCIONAL que espejar (`x`/`skewX` distintos
  // de cero): en cualquier otro caso sería un duplicado exacto, bytes por nada en el manifiesto.
  const mirrored =
    (union.includes("x") || union.includes("skewX")) &&
    track.steps.some((s) => (s.set.x ?? 0) !== 0 || (s.set.skewX ?? 0) !== 0);
  const out: IxRuntimeTrack = {
    kf: track.steps.map((s) => keyframeOf(s, union, ctx)),
    ...(mirrored ? { kfRtl: track.steps.map((s) => keyframeOf(s, union, ctx, "rtl")) } : {}),
    target: track.target,
    range: rangeOf(trigger),
    dur: track.dur ?? IX_DEFAULT_DUR,
    delay: (track.delay ?? IX_DEFAULT_DELAY) + loadDelay,
    repeat: track.repeat ?? 1,
    alt: track.alt === true,
  };
  if (track.stagger && track.stagger.each > 0) {
    out.stagger = { each: track.stagger.each, from: track.stagger.from ?? "start" };
    if (track.stagger.total === true) out.stagger.total = true;
    if (track.stagger.cols !== undefined) out.stagger.cols = track.stagger.cols;
  }
  if (track.axis === "y") out.axis = "y";
  return out;
}

export function toRuntimeUnit(unit: IxUnit): IxRuntimeUnit {
  const out: IxRuntimeUnit = {
    cls: unit.cls,
    needsRuntime: unit.needsRuntime,
    trigger: unit.body.trigger,
    tracks: unit.body.tracks.map((t) => toRuntimeTrack(t, unit.body.trigger, unit.body.amt ?? 1)),
  };
  if (unit.media) out.media = unit.media;
  return out;
}

export type { IxSpec };
