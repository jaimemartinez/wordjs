/**
 * Verso — MODELO PURO del panel de interacciones (F9-D). Sin React, sin DOM: aquí vive todo lo que
 * el panel decide, para que se pueda probar en el entorno node de vitest (el proyecto no tiene
 * jsdom y las dependencias nuevas están vetadas). `InteractionsControl.tsx` es solo markup + estos
 * transformadores.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LAS DOS REGLAS DE ESTE MÓDULO
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. **Nada muta.** Cada escritor recibe el valor CRUDO de `props.ix` y devuelve un valor NUEVO
 *    (o `undefined` = quitar la prop). Quien llama lo mete en el documento por `transact/setProps`,
 *    que es el único camino con historia, undo y round-trip. El panel jamás toca un objeto vivo.
 *
 * 2. **Todo sale normalizado.** Cada escritura pasa por `normalizeIxSpec` ANTES de devolverse, así
 *    que en el documento no puede aterrizar un `ix` que el compilador no acepte. Es exactamente la
 *    postura de `clampAnimSpec` con `anim` (clampar en la frontera de ESCRITURA además del render),
 *    llevada a un tipo entero. Consecuencia deliberada: si un cambio deja la interacción sin nada
 *    animable (p.ej. quitar la última propiedad de todos los pasos), la escritura devuelve
 *    `undefined` y la prop desaparece — el bloque queda visible y quieto, nunca a medias.
 *
 * TRES NIVELES (§6.1 de la spec): preajuste → disparador → pasos. El panel NO edita las pistas 2 y
 * 3 de un preset: un cuerpo con varias pistas se muestra, pero para tocarlo hay que **desvincular**
 * (copiar el cuerpo del preset a `tracks`). Una bifurcación silenciosa rompería la propagación —
 * que es el motivo entero de que los presets se guarden por referencia.
 */
import {
  IX_BREAKPOINTS,
  IX_COLOR_PROP_KEYS,
  IX_DEFAULT_RANGES,
  IX_EVENT_NAME_RE,
  IX_DELAY_MAX,
  IX_DELAY_MIN,
  IX_DUR_MAX,
  IX_DUR_MIN,
  IX_MAX_STEPS,
  IX_MAX_TRACKS,
  IX_PROP_KEYS,
  IX_REPEAT_MAX,
  IX_STAGGER_MAX,
  normalizeIxSpec,
  resolveIxBody,
  type IxBreakpoint,
  type IxClipDir,
  type IxColorPropKey,
  type IxColorToken,
  type IxCompileCtx,
  type IxEase,
  type IxEdgeName,
  type IxOrigin,
  type IxPreset,
  type IxPropKey,
  type IxProps,
  type IxRange,
  type IxSpec,
  type IxStaggerFrom,
  type IxStep,
  type IxTarget,
  type IxTrack,
  type IxTrigger,
} from "@/lib/verso/interactions";

/** Etiquetas de autor del gating responsive (P4) — el espejo de los botones de visibilidad. */
export const IX_BREAKPOINT_LABELS: Readonly<Record<IxBreakpoint, string>> = Object.freeze({
  mobile: "Móvil",
  tablet: "Tablet",
  desktop: "Escritorio",
});

/** Etiquetas del ORDEN del escalonado (P4). */
export const IX_STAGGER_FROM_LABELS: Readonly<Record<IxStaggerFrom, string>> = Object.freeze({
  start: "Desde el principio",
  end: "Desde el final",
  center: "Desde el centro",
});

/* ------------------------------------------------------------------ */
/* Vocabulario del panel (el DATO no se traduce; la UI sí)             */
/* ------------------------------------------------------------------ */

export type IxPanelTriggerKind = IxTrigger["on"];
/** El panel no ofrece `block` (objetivo externo): sin `timeline-scope` sería siempre runtime. */
export type IxPanelTargetKind = "self" | "children" | "words" | "svg";

/** Sentinel del selector de preajuste: cuerpo propio, sin preset detrás. */
export const IX_PANEL_CUSTOM = "@custom";
/** Sentinel del selector de preajuste: sin interacción. */
export const IX_PANEL_NONE = "";

export const IX_TRIGGER_LABELS: Readonly<Record<IxPanelTriggerKind, string>> = Object.freeze({
  view: "Al entrar en pantalla",
  scrub: "Con el scroll",
  hover: "Al pasar el ratón",
  click: "Al hacer clic",
  load: "Al cargar la página",
  pointer: "Al mover el puntero",
  event: "Con un evento a medida",
});

/** Eje del cursor por pista (P6). */
export const IX_AXIS_LABELS: Readonly<Record<"x" | "y", string>> = Object.freeze({
  x: "Horizontal",
  y: "Vertical",
});

export const IX_TARGET_LABELS: Readonly<Record<IxPanelTargetKind, string>> = Object.freeze({
  self: "Este bloque",
  children: "Sus hijos",
  words: "Las palabras",
  // P12 — solo hace algo en bloques cuyo SVG cumpla el contrato .wjs-ixd + pathLength=1.
  svg: "El trazo SVG",
});

export const IX_EASE_LABELS: Readonly<Record<IxEase, string>> = Object.freeze({
  linear: "Constante",
  in: "Acelera",
  out: "Frena",
  "in-out": "Suave",
  spring: "Muelle",
  back: "Impulso",
  // Físicas compiladas a `linear()` — cero JS en la página; la simulación corre en el compilador.
  bounce: "Rebote",
  elastic: "Elástico",
});

/**
 * Aristas de `animation-range`, en lenguaje de autor. El DATO conserva el vocabulario de la
 * especificación (`cover`/`entry`/…); estas frases describen el RECORRIDO que cada arista define,
 * que es lo que el autor está eligiendo.
 */
export const IX_EDGE_LABELS: Readonly<Record<IxEdgeName, string>> = Object.freeze({
  cover: "Todo el recorrido",
  entry: "Mientras entra",
  contain: "Mientras está entero",
  exit: "Mientras sale",
});

export const IX_PROP_LABELS: Readonly<Record<IxPropKey, string>> = Object.freeze({
  opacity: "Opacidad",
  x: "Mover en X",
  y: "Mover en Y",
  scale: "Escala",
  rotate: "Girar",
  rotateX: "Voltear",
  blur: "Desenfoque",
  clip: "Revelado",
  z: "Profundidad (Z)",
  scaleX: "Escala X",
  scaleY: "Escala Y",
  rotateY: "Girar en Y",
  skewX: "Sesgar X",
  skewY: "Sesgar Y",
  brightness: "Brillo",
  contrast: "Contraste",
  saturate: "Saturación",
  grayscale: "Escala de grises",
  hue: "Tono",
  textColor: "Color del texto",
  bgColor: "Color de fondo",
  borderColor: "Color del borde",
  draw: "Trazado SVG",
});

export const IX_PROP_UNITS: Readonly<Record<IxPropKey, string>> = Object.freeze({
  opacity: "",
  x: "px",
  y: "px",
  scale: "×",
  rotate: "°",
  rotateX: "°",
  blur: "px",
  clip: "%",
  z: "px",
  scaleX: "×",
  scaleY: "×",
  rotateY: "°",
  skewX: "°",
  skewY: "°",
  brightness: "×",
  contrast: "×",
  saturate: "×",
  grayscale: "%",
  hue: "°",
  textColor: "",
  bgColor: "",
  borderColor: "",
  draw: "%",
});

/**
 * Propiedades que el panel edita con un SELECTOR DE COLOR (el dato sigue siendo un número
 * 0xRRGGBB; la conversión hex↔entero es cosa del control, nunca del documento).
 *
 * Sale de la lista canónica del normalizador, no de una copia: son las MISMAS claves que aceptan un
 * color del tema, y dos listas escritas a mano acabarían discrepando el día que se añada la cuarta.
 */
export const IX_COLOR_PROPS: ReadonlySet<IxPropKey> = new Set<IxPropKey>(IX_COLOR_PROP_KEYS);

/**
 * Rangos de los CONTROLES. Deliberadamente más estrechos que los del normalizador
 * (`IX_PROP_RANGE`, que admite ±4000px porque tiene que sobrevivir a un `_puck_data` hostil): esto
 * es una afordancia de autor, no una frontera de seguridad. La frontera sigue siendo el
 * normalizador, que clampa pase lo que pase — un valor tecleado fuera de rango se acepta y se
 * clampa allí, no se pierde en silencio.
 */
export const IX_PROP_INPUT: Readonly<Record<IxPropKey, { min: number; max: number; step: number }>> =
  Object.freeze({
    opacity: { min: 0, max: 1, step: 0.05 },
    x: { min: -600, max: 600, step: 1 },
    y: { min: -600, max: 600, step: 1 },
    scale: { min: 0, max: 3, step: 0.01 },
    rotate: { min: -360, max: 360, step: 1 },
    rotateX: { min: -180, max: 180, step: 1 },
    blur: { min: 0, max: 40, step: 1 },
    clip: { min: 0, max: 100, step: 1 },
    z: { min: -1000, max: 1000, step: 1 },
    scaleX: { min: 0, max: 3, step: 0.01 },
    scaleY: { min: 0, max: 3, step: 0.01 },
    rotateY: { min: -180, max: 180, step: 1 },
    skewX: { min: -45, max: 45, step: 1 },
    skewY: { min: -45, max: 45, step: 1 },
    brightness: { min: 0, max: 3, step: 0.05 },
    contrast: { min: 0, max: 3, step: 0.05 },
    saturate: { min: 0, max: 3, step: 0.05 },
    grayscale: { min: 0, max: 100, step: 1 },
    hue: { min: -360, max: 360, step: 1 },
    // Colores: el rango es el entero RGB completo; el control real es <input type="color">.
    textColor: { min: 0, max: 0xffffff, step: 1 },
    bgColor: { min: 0, max: 0xffffff, step: 1 },
    borderColor: { min: 0, max: 0xffffff, step: 1 },
    draw: { min: 0, max: 100, step: 1 },
  });

/* ------------------------------------------------------------------ */
/* Cuerpo inicial de una interacción propia                            */
/* ------------------------------------------------------------------ */

/**
 * Lo que aparece al elegir "Personalizada" en un bloque sin interacción: la entrada de siempre
 * (aparecer subiendo), que es el movimiento que el 90 % quiere y el punto de partida más corto
 * hacia cualquier otro. Función y no constante: el objeto se escribe en el documento, y compartir
 * una referencia entre dos bloques sería una fuga de aliasing esperando a ocurrir.
 */
export function defaultIxSpec(): IxSpec {
  return {
    v: 1,
    trigger: { on: "view", once: true },
    tracks: [
      {
        target: { kind: "self" },
        steps: [
          { at: 0, set: { opacity: 0, y: 24 }, ease: "out" },
          { at: 100, set: { opacity: 1, y: 0 } },
        ],
        dur: 600,
        delay: 0,
      },
    ],
  };
}

/** Paso nuevo: neutro salvo la opacidad, para que añadirlo NO cambie lo que se ve de golpe. */
const blankStep = (at: number): IxStep => ({ at, set: { opacity: 1 }, ease: "out" });

/* ------------------------------------------------------------------ */
/* Lectura                                                             */
/* ------------------------------------------------------------------ */

export interface IxPanelPresetOption {
  value: string;
  label: string;
}

export interface IxPanelState {
  /** Hay interacción utilizable (la referencia a un preset borrado NO cuenta: fail-open). */
  active: boolean;
  /** Lo que el bloque tiene guardado, ya normalizado. `null` = nada. */
  spec: IxSpec | null;
  /** Id del preset enlazado (aunque esté roto: el panel tiene que poder decirlo). */
  presetId: string | null;
  /** El preset existe y se resolvió. */
  presetOk: boolean;
  /** El cuerpo es propio (`tracks`) → los pasos se pueden editar. */
  custom: boolean;
  /** Disparador EFECTIVO (el del bloque si lo hay; si no, el del preset). */
  trigger: IxTrigger;
  /** Pistas EFECTIVAS (propias o del preset). Vacío si no hay nada resoluble. */
  tracks: IxTrack[];
  /** Avisos de topes/capacidades del normalizador y del compilador. Nunca rompen nada. */
  warnings: string[];
  /** Frase para el `aria-live` del panel: qué hay puesto, en una línea. */
  summary: string;
}

const DEFAULT_TRIGGER: IxTrigger = { on: "view", once: true };

/** Estado completo del panel para un valor crudo de `props.ix`. Nunca lanza. */
export function ixPanelState(raw: unknown, ctx?: IxCompileCtx): IxPanelState {
  const norm = normalizeIxSpec(raw);
  if (!norm) {
    return {
      active: false,
      spec: null,
      presetId: null,
      presetOk: false,
      custom: false,
      trigger: DEFAULT_TRIGGER,
      tracks: [],
      warnings: [],
      summary: "Sin interacción.",
    };
  }

  const { spec } = norm;
  const presetId = spec.preset ?? null;
  const resolved = resolveIxBody(spec, ctx);
  const presetOk = presetId === null ? false : resolved !== null;
  const tracks = resolved ? resolved.body.tracks : (spec.tracks ?? []);
  const trigger = resolved ? resolved.body.trigger : (spec.trigger ?? DEFAULT_TRIGGER);
  const warnings = [...norm.warnings, ...(resolved?.warnings ?? [])];
  if (presetId !== null && !presetOk) {
    warnings.push(
      `el preajuste «${presetId}» ya no existe en los ajustes del sitio: el bloque se ve, pero no se mueve`,
    );
  }

  const active = resolved !== null;
  return {
    active,
    spec,
    presetId,
    presetOk,
    custom: presetId === null && (spec.tracks?.length ?? 0) > 0,
    trigger,
    tracks,
    warnings,
    summary: ixSummary(presetId, presetOk, trigger, tracks, ctx),
  };
}

/** Nombre legible del preajuste elegido, para el resumen. */
function presetName(id: string | null, ctx?: IxCompileCtx): string {
  if (id === null) return "Personalizada";
  return ctx?.presets?.[id]?.name ?? id;
}

/**
 * La frase del `aria-live`. Se anuncia el RESULTADO, no el gesto: quien no ve el lienzo necesita
 * saber qué hay puesto ahora, no que "se ha pulsado un botón".
 */
export function ixSummary(
  presetId: string | null,
  presetOk: boolean,
  trigger: IxTrigger,
  tracks: readonly IxTrack[],
  ctx?: IxCompileCtx,
): string {
  if (tracks.length === 0) {
    if (presetId !== null && !presetOk) return `Preajuste «${presetId}» no encontrado: sin movimiento.`;
    return "Sin interacción.";
  }
  const target = tracks[0].target.kind;
  const targetLabel =
    target === "block"
      ? "otro bloque"
      : IX_TARGET_LABELS[target as IxPanelTargetKind].toLowerCase();
  const steps = tracks[0].steps.length;
  const parts = [
    `Interacción: ${presetName(presetId, ctx)}`,
    IX_TRIGGER_LABELS[trigger.on].toLowerCase(),
    targetLabel,
    `${steps} ${steps === 1 ? "paso" : "pasos"}`,
  ];
  return `${parts.join(" · ")}.`;
}

/**
 * Opciones del selector de preajuste: Ninguna, los del SISTEMA, los del SITIO y "Personalizada".
 *
 * Orden explícito y estable — no el de `Object.keys`, que es de inserción y aquí depende de un
 * ajuste que puede llegar en cualquier orden: primero el grupo del sistema, luego el del sitio, y
 * dentro de cada grupo POR NOMBRE (que es lo que el autor lee), con el id como desempate para que
 * dos preajustes homónimos no bailen entre renders.
 */
export function ixPresetOptions(ctx?: IxCompileCtx): IxPanelPresetOption[] {
  const presets = ctx?.presets ?? {};
  const toOption = (id: string): IxPanelPresetOption => ({
    value: id,
    label: (presets[id] as IxPreset).name || id,
  });
  const byLabel = (a: IxPanelPresetOption, b: IxPanelPresetOption): number =>
    a.label.localeCompare(b.label, "es") || a.value.localeCompare(b.value);
  const ids = Object.keys(presets);
  const sys = ids.filter((id) => id.startsWith("sys:")).map(toOption).sort(byLabel);
  const site = ids.filter((id) => !id.startsWith("sys:")).map(toOption).sort(byLabel);
  return [
    { value: IX_PANEL_NONE, label: "Ninguna" },
    ...sys,
    ...site,
    { value: IX_PANEL_CUSTOM, label: "Personalizada…" },
  ];
}

/** Valor que debe mostrar el selector de preajuste para el estado actual. */
export function ixPresetChoice(state: IxPanelState): string {
  if (state.presetId !== null) return state.presetId;
  if (state.custom) return IX_PANEL_CUSTOM;
  return IX_PANEL_NONE;
}

/* ------------------------------------------------------------------ */
/* Escritura — todas devuelven el nuevo valor de `props.ix`            */
/* ------------------------------------------------------------------ */

/** El valor que se escribe en el documento: normalizado, o `undefined` (quitar la prop). */
export type IxWrite = IxSpec | undefined;

/** La única salida del módulo: nada llega al documento sin pasar por aquí. */
function write(spec: IxSpec): IxWrite {
  const norm = normalizeIxSpec(spec);
  return norm ? norm.spec : undefined;
}

/** Estado efectivo como cuerpo PROPIO editable (lo que hace falta para tocar los pasos). */
function ownBody(raw: unknown, ctx?: IxCompileCtx): { trigger: IxTrigger; tracks: IxTrack[] } {
  const state = ixPanelState(raw, ctx);
  if (state.tracks.length === 0) {
    const seed = defaultIxSpec();
    return { trigger: seed.trigger!, tracks: seed.tracks! };
  }
  return { trigger: state.trigger, tracks: state.tracks };
}

/** Selector de preajuste: Ninguna / un preset / Personalizada. */
export function setPresetChoice(raw: unknown, choice: string, ctx?: IxCompileCtx): IxWrite {
  if (choice === IX_PANEL_NONE) return undefined;
  if (choice === IX_PANEL_CUSTOM) {
    const state = ixPanelState(raw, ctx);
    // Venir de un preset y elegir "Personalizada" ES desvincular: se copia el cuerpo resuelto.
    if (state.tracks.length > 0) {
      return withSpecExtras(raw, { v: 1, trigger: state.trigger, tracks: state.tracks });
    }
    return withSpecExtras(raw, defaultIxSpec());
  }
  // Enlazar a un preset: el bloque guarda un ID y NADA MÁS (ni una copia del cuerpo). Un `trigger`
  // propio anterior se descarta a propósito: el preajuste trae el suyo, y conservar el viejo haría
  // que elegir un preset diese un resultado distinto según lo que hubiera antes. `off` y `amt` SÍ
  // se conservan: son del bloque (dónde corre y con qué fuerza), no del movimiento elegido.
  return withSpecExtras(raw, { v: 1, preset: choice });
}

/** "Desvincular del preajuste": copia el cuerpo a `tracks` y borra la referencia. Sin vuelta atrás. */
export function unlinkPreset(raw: unknown, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.tracks.length === 0) return undefined;
  return write({ v: 1, trigger: state.trigger, tracks: state.tracks });
}

/** Quitar la interacción. `undefined` borra la clave: el bloque vuelve a sus bytes de origen. */
export function clearIx(): IxWrite {
  return undefined;
}

/**
 * Cambiar el disparador. Un bloque enlazado a un preset PUEDE llevar su propio `trigger` (y solo
 * eso): es el único override local que no bifurca el cuerpo, así que la propagación del preajuste
 * sigue intacta.
 */
export function setTriggerKind(raw: unknown, kind: IxPanelTriggerKind, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  const trigger: IxTrigger =
    kind === "view"
      ? { on: "view", once: state.trigger.on === "view" ? state.trigger.once !== false : true }
      : kind === "scrub"
        ? { on: "scrub" }
        : kind === "click"
          ? { on: "click" }
          : kind === "hover"
            ? { on: "hover" }
            : kind === "pointer"
              ? { on: "pointer" }
              : kind === "event"
                ? { on: "event", name: "mi-evento" }
                : { on: "load" };

  return writeTrigger(raw, ctx, trigger);
}

/**
 * Escribir un disparador nuevo conservando la naturaleza del cuerpo: el override de `trigger` es lo
 * ÚNICO que un bloque enlazado a un preajuste puede llevar, así que la propagación sigue intacta.
 */
function writeTrigger(raw: unknown, ctx: IxCompileCtx | undefined, trigger: IxTrigger): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.presetId !== null) {
    return withSpecExtras(raw, { v: 1, preset: state.presetId, trigger });
  }
  const body = ownBody(raw, ctx);
  return withSpecExtras(raw, { v: 1, trigger, tracks: body.tracks });
}

/** `view`: una sola vez (con latch de JS) o cada vez que entra y sale (CSS puro). */
export function setViewOnce(raw: unknown, once: boolean, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "view") return normalizeIxSpec(raw)?.spec;
  // El rango del autor sobrevive al cambio de repetición: pertenece al "cuándo", no al "cuántas".
  const trigger: IxTrigger = { on: "view", once };
  if (state.trigger.range) trigger.range = state.trigger.range;
  return writeTrigger(raw, ctx, trigger);
}

/** `click`: conmutar (segundo clic deshace) o quedarse (el primer clic es definitivo). */
export function setClickToggle(raw: unknown, toggle: boolean, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "click") return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger = toggle ? { on: "click", toggle: true } : { on: "click" };
  return writeTrigger(raw, ctx, trigger);
}

/** `load`: retardo del DISPARADOR (se suma al de cada pista). 0 lo quita. */
export function setLoadDelay(raw: unknown, ms: number, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "load") return normalizeIxSpec(raw)?.spec;
  const delay = clampInput(ms, IX_DELAY_MIN, IX_DELAY_MAX, 0);
  const trigger: IxTrigger = delay > 0 ? { on: "load", delay } : { on: "load" };
  return writeTrigger(raw, ctx, trigger);
}

/** De dónde sale el progreso de un `scrub`. `self` es el defecto y se escribe desnudo. */
export type IxScrubSrc = "self" | "page" | "scene";

/** La fuente EFECTIVA de un disparador, para pintar el desplegable. */
export const scrubSrcOf = (t: IxTrigger): IxScrubSrc =>
  t.on === "scrub" && (t.src === "page" || t.src === "scene") ? t.src : "self";

/**
 * La fuente, lista para reinyectarse al RECONSTRUIR un disparador de scrub.
 *
 * Existe porque reconstruir el disparador es lo que hacen media docena de escritores (rango, reset,
 * suavizado…) y cada uno que se escribiera "a mano" volvería a perder la fuente en silencio — el
 * defecto exacto que el barrido adversarial del ciclo 2 encontró con `smooth`.
 */
const carryScrubSrc = (t: IxTrigger): { src?: Exclude<IxScrubSrc, "self"> } => {
  const src = scrubSrcOf(t);
  return src === "self" ? {} : { src };
};

/** `scrub`: el progreso lo marca el bloque (`self`), el scroll de la página o la escena fija. */
export function setScrubSrc(raw: unknown, src: IxScrubSrc, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "scrub") return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger = { on: "scrub" };
  if (src !== "self") trigger.src = src;
  if (state.trigger.range) trigger.range = state.trigger.range;
  // El suavizado (P10) viaja CON el disparador: reconstruirlo sin él lo borraría en silencio y
  // devolvería la unidad al camino nativo — el mismo cuidado que setPointerArea tiene con el suyo.
  if (state.trigger.smooth !== undefined) trigger.smooth = state.trigger.smooth;
  return writeTrigger(raw, ctx, trigger);
}

/** `pointer` (P6): qué área normaliza el cursor. `self` (el defecto) se escribe desnudo. */
export function setPointerArea(raw: unknown, area: "self" | "page", ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "pointer") return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger = { on: "pointer" };
  if (area === "page") trigger.area = "page";
  if (state.trigger.smooth !== undefined) trigger.smooth = state.trigger.smooth;
  return writeTrigger(raw, ctx, trigger);
}

/** `pointer` (P6): suavizado de persecución en ms. El defecto lo borra el normalizador. */
export function setPointerSmooth(raw: unknown, ms: number, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "pointer") return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger = { on: "pointer", smooth: ms };
  if (state.trigger.area === "page") trigger.area = "page";
  return writeTrigger(raw, ctx, trigger);
}

/** Eje del cursor de UNA pista (P6). "x" (el defecto) borra la clave. */
export function setTrackAxis(raw: unknown, axis: "x" | "y", ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(
    raw,
    ctx,
    (t) => {
      const next: IxTrack = { ...t };
      if (axis === "y") next.axis = "y";
      else delete next.axis;
      return next;
    },
    track,
  );
}

/** `event` (P11): nombre del evento. Un slug inválido se conserva como texto hasta ser válido NO —
 * el escritor solo escribe slugs válidos; con uno inválido devuelve el spec sin tocar (el control
 * enseña el error). */
export function setEventName(raw: unknown, name: string, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "event") return normalizeIxSpec(raw)?.spec;
  if (!IX_EVENT_NAME_RE.test(name)) return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger = { on: "event", name };
  if (state.trigger.toggle === true) trigger.toggle = true;
  return writeTrigger(raw, ctx, trigger);
}

/** `event` (P11): conmutación, como el clic. */
export function setEventToggle(raw: unknown, toggle: boolean, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "event") return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger = { on: "event", name: state.trigger.name };
  if (toggle) trigger.toggle = true;
  return writeTrigger(raw, ctx, trigger);
}

/** `scrub` (P10): suavizado opt-in en ms; 0 lo quita y devuelve la exactitud nativa. */
export function setScrubSmooth(raw: unknown, ms: number, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "scrub") return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger = { on: "scrub", smooth: ms, ...carryScrubSrc(state.trigger) };
  if (state.trigger.range) trigger.range = state.trigger.range;
  return writeTrigger(raw, ctx, trigger);
}

/** ¿El disparador efectivo tiene un rango de scroll editable? (scrub, o view que entra y sale). */
export function rangeEditable(trigger: IxTrigger): boolean {
  return trigger.on === "scrub" || (trigger.on === "view" && trigger.once === false);
}

/**
 * El rango que el panel debe MOSTRAR: el del autor si lo hay, y si no el por defecto del
 * compilador — copiado en profundidad, porque el destino de este objeto es el documento y compartir
 * la referencia congelada del compilador sería una fuga de aliasing.
 */
export function effectiveRange(trigger: IxTrigger): IxRange {
  const base =
    (trigger.on === "scrub" || trigger.on === "view" ? trigger.range : undefined) ??
    IX_DEFAULT_RANGES[trigger.on === "scrub" ? "scrub" : "view"];
  return {
    from: { at: base.from.at, pct: base.from.pct },
    to: { at: base.to.at, pct: base.to.pct },
  };
}

/** Editar UN borde del rango (nombre de arista, %, o ambos). */
export function setRangeEdge(
  raw: unknown,
  which: "from" | "to",
  patch: { at?: IxEdgeName; pct?: number },
  ctx?: IxCompileCtx,
): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (!rangeEditable(state.trigger)) return normalizeIxSpec(raw)?.spec;
  const range = effectiveRange(state.trigger);
  const edge = range[which];
  if (patch.at !== undefined) edge.at = patch.at;
  if (patch.pct !== undefined) edge.pct = clampInput(Math.round(patch.pct), 0, 100, edge.pct);
  const trigger: IxTrigger =
    state.trigger.on === "scrub"
      ? {
          on: "scrub",
          range,
          ...carryScrubSrc(state.trigger),
          // El suavizado (P10) sobrevive a editar el rango: reconstruir sin él lo borraría.
          ...(state.trigger.smooth !== undefined ? { smooth: state.trigger.smooth } : {}),
        }
      : { on: "view", once: false, range };
  return writeTrigger(raw, ctx, trigger);
}

/** Volver al rango por defecto: se BORRA el del autor (ausencia = defecto del compilador). */
export function resetRange(raw: unknown, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (!rangeEditable(state.trigger)) return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger =
    state.trigger.on === "scrub"
      ? {
          on: "scrub",
          ...carryScrubSrc(state.trigger),
          // El suavizado (P10) no es parte del rango: volver al rango por defecto no lo toca.
          ...(state.trigger.smooth !== undefined ? { smooth: state.trigger.smooth } : {}),
        }
      : { on: "view", once: false };
  return writeTrigger(raw, ctx, trigger);
}

/**
 * Patch de UNA pista conservando el resto tal cual (P5: el panel edita las tres).
 *
 * Escribe SIEMPRE un cuerpo propio. Si el bloque estaba enlazado a un preajuste, tocar un paso lo
 * DESVINCULA (copiando el cuerpo resuelto): es la única salida coherente, porque un `tracks` junto
 * a un `preset` sería una bifurcación silenciosa que rompe la propagación. El panel no ofrece ese
 * camino —con un preajuste puesto los pasos se muestran en solo lectura y hay un botón
 * "Desvincular"—, pero el modelo no puede devolver algo incoherente si alguien lo llama igual.
 *
 * `off` y el resto de claves de bloque sobreviven al patch: el cuerpo propio se reescribe entero,
 * pero el spec de partida es el normalizado del bloque, así que el gating no se pierde al editar.
 */
function patchTrack(
  raw: unknown,
  ctx: IxCompileCtx | undefined,
  index: number,
  patch: (track: IxTrack) => IxTrack | null,
): IxWrite {
  const body = ownBody(raw, ctx);
  if (index < 0 || index >= body.tracks.length) return normalizeIxSpec(raw)?.spec;
  const next = patch(body.tracks[index]);
  const tracks =
    next === null
      ? body.tracks.filter((_, i) => i !== index)
      : body.tracks.map((t, i) => (i === index ? next : t));
  if (tracks.length === 0) return undefined;
  return withSpecExtras(raw, { v: 1, trigger: body.trigger, tracks });
}

/** Compatibilidad interna: los escritores existentes editan la pista que se les indique (o la 0). */
function patchTrack0(
  raw: unknown,
  ctx: IxCompileCtx | undefined,
  patch: (track: IxTrack) => IxTrack | null,
  index = 0,
): IxWrite {
  return patchTrack(raw, ctx, index, patch);
}

/**
 * Conserva en el spec nuevo las claves de BLOQUE que no dependen del cuerpo (`off`, `amt`).
 * TODO reconstructor de spec pasa por aquí: si no, cambiar el disparador o el preajuste perdería
 * en silencio el gating por dispositivo o la intensidad — que son decisiones del BLOQUE, no del
 * movimiento elegido.
 */
function withSpecExtras(raw: unknown, spec: IxSpec): IxWrite {
  const prev = normalizeIxSpec(raw)?.spec;
  if (prev?.off && spec.off === undefined) spec.off = prev.off;
  if (prev?.amt !== undefined && spec.amt === undefined) spec.amt = prev.amt;
  return write(spec);
}

/* ------------------------------------------------------------------ */
/* Pistas (P5)                                                         */
/* ------------------------------------------------------------------ */

/**
 * Añadir una pista (máx. IX_MAX_TRACKS). Nace NEUTRA de verdad —dos pasos de opacidad 1 a 1— no
 * "aparecer subiendo": una segunda pista que moviera el bloque nada más nacer pisaría a la primera
 * sin que el autor hubiera pedido nada. El normalizador exige que una pista toque ALGO: la
 * opacidad declarada (aunque neutra) lo satisface, y el autor cambia lo que quiera desde ahí.
 */
export function addTrack(raw: unknown, ctx?: IxCompileCtx): IxWrite {
  const body = ownBody(raw, ctx);
  if (body.tracks.length >= IX_MAX_TRACKS) return normalizeIxSpec(raw)?.spec;
  const track: IxTrack = {
    target: { kind: "self" },
    steps: [
      { at: 0, set: { opacity: 1 }, ease: "out" },
      { at: 100, set: { opacity: 1 } },
    ],
  };
  return withSpecExtras(raw, { v: 1, trigger: body.trigger, tracks: [...body.tracks, track] });
}

/**
 * SOLTAR UN CLIP (dock, timeline de editor de vídeo): un preajuste arrastrado a la línea de tiempo.
 *
 * Dos comportamientos, ambos honestos con el modelo de presets:
 *  - SIN cuerpo propio (nada, o enlazado a un preajuste): soltar APLICA el preajuste — el nivel 1
 *    de siempre, por REFERENCIA (la propagación es el motivo entero de los presets). El punto de
 *    suelta se ignora a propósito: poner un retardo bifurcaría el preajuste en silencio.
 *  - CON cuerpo propio: la pista 0 del preajuste se COPIA como pista nueva — el clip — con el
 *    retardo del punto de suelta. El disparador del preajuste se descarta: una interacción tiene
 *    UN disparador (el del bloque), como el resto de escritores de pista. Al tope de pistas, o con
 *    un preajuste inexistente, no se escribe nada.
 */
export function addTrackFromPreset(
  raw: unknown,
  presetId: string,
  ctx?: IxCompileCtx,
  delayMs?: number,
): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (!state.custom) return setPresetChoice(raw, presetId, ctx);
  const body = ownBody(raw, ctx);
  if (body.tracks.length >= IX_MAX_TRACKS) return normalizeIxSpec(raw)?.spec;
  const resolved = resolveIxBody({ v: 1, preset: presetId }, ctx);
  const src = resolved?.body.tracks[0];
  if (!src) return normalizeIxSpec(raw)?.spec;
  const track: IxTrack = { ...src };
  if (delayMs !== undefined) {
    const delay = clampInput(Math.round(delayMs), IX_DELAY_MIN, IX_DELAY_MAX, 0);
    if (delay > 0) track.delay = delay;
    else delete track.delay;
  }
  return withSpecExtras(raw, { v: 1, trigger: body.trigger, tracks: [...body.tracks, track] });
}

/** Quitar una pista. La última no se quita (para eso está «Quitar» la interacción entera). */
export function removeTrack(raw: unknown, index: number, ctx?: IxCompileCtx): IxWrite {
  const body = ownBody(raw, ctx);
  if (body.tracks.length <= 1) return normalizeIxSpec(raw)?.spec;
  if (index < 0 || index >= body.tracks.length) return normalizeIxSpec(raw)?.spec;
  return withSpecExtras(raw, {
    v: 1,
    trigger: body.trigger,
    tracks: body.tracks.filter((_, i) => i !== index),
  });
}

export function setTargetKind(raw: unknown, kind: IxPanelTargetKind, ctx?: IxCompileCtx, track = 0): IxWrite {
  const target: IxTarget = { kind };
  return patchTrack0(raw, ctx, (t) => ({ ...t, target }), track);
}
/** Escalonado entre hermanos (ms). 0 lo quita. */
export function setStagger(raw: unknown, each: number, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (!Number.isFinite(each) || each <= 0) {
      const next: IxTrack = { ...t };
      delete next.stagger;
      return next;
    }
    return { ...t, stagger: { ...(t.stagger ?? {}), each: Math.min(each, IX_STAGGER_MAX) } };
  }, track);
}
/** Orden del escalonado (P4). `start` (el defecto) borra la clave. Sin escalonado, no-op. */
export function setStaggerFrom(raw: unknown, from: IxStaggerFrom, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (!t.stagger) return t;
    const st = { ...t.stagger };
    if (from === "start") delete st.from;
    else st.from = from;
    return { ...t, stagger: st };
  }, track);
}
/** Modo tiempo-TOTAL del escalonado (P4): `each` pasa a ser el tiempo del primero al último. */
export function setStaggerTotal(raw: unknown, total: boolean, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (!t.stagger) return t;
    const st = { ...t.stagger };
    if (total) st.total = true;
    else delete st.total;
    return { ...t, stagger: st };
  }, track);
}
/** Rejilla del escalonado (P4): columnas declaradas por el autor. `null` vuelve al modo lineal. */
export function setStaggerCols(raw: unknown, cols: number | null, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (!t.stagger) return t;
    const st = { ...t.stagger };
    if (cols === null || !Number.isFinite(cols)) delete st.cols;
    else st.cols = cols;
    return { ...t, stagger: st };
  }, track);
}
/**
 * Intensidad del bloque (P7): multiplica la distancia al neutro de las propiedades espaciales.
 * Del BLOQUE, como `off`: sobrevive enlazada a un preajuste sin bifurcarlo. 1 borra la clave.
 */
export function setIntensity(raw: unknown, amt: number, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  const spec = normalizeIxSpec(raw)?.spec;
  if (state.presetId !== null) {
    const w: IxSpec = { v: 1, preset: state.presetId };
    if (spec?.trigger) w.trigger = spec.trigger;
    if (spec?.off) w.off = spec.off;
    if (Number.isFinite(amt)) w.amt = amt;
    return write(w);
  }
  const body = ownBody(raw, ctx);
  const w: IxSpec = { v: 1, trigger: body.trigger, tracks: body.tracks };
  if (spec?.off) w.off = spec.off;
  if (Number.isFinite(amt)) w.amt = amt;
  return write(w);
}

/**
 * Gating responsive (P4): apagar/encender la interacción en un dispositivo. Es del BLOQUE — el
 * único ajuste, junto al disparador, que un bloque enlazado a un preajuste puede llevar encima.
 */
export function setBreakpointOff(
  raw: unknown,
  bp: IxBreakpoint,
  isOff: boolean,
  ctx?: IxCompileCtx,
): IxWrite {
  const state = ixPanelState(raw, ctx);
  const spec = normalizeIxSpec(raw)?.spec;
  const cur = new Set<IxBreakpoint>(spec?.off ?? []);
  if (isOff) cur.add(bp);
  else cur.delete(bp);
  const off = IX_BREAKPOINTS.filter((b) => cur.has(b));
  if (state.presetId !== null) {
    const w: IxSpec = { v: 1, preset: state.presetId };
    if (spec?.trigger) w.trigger = spec.trigger;
    if (off.length > 0) w.off = off;
    if (spec?.amt !== undefined) w.amt = spec.amt;
    return write(w);
  }
  const body = ownBody(raw, ctx);
  const w: IxSpec = { v: 1, trigger: body.trigger, tracks: body.tracks };
  if (off.length > 0) w.off = off;
  if (spec?.amt !== undefined) w.amt = spec.amt;
  return write(w);
}

export function setDuration(raw: unknown, ms: number, ctx?: IxCompileCtx, track = 0): IxWrite {
  const dur = clampInput(ms, IX_DUR_MIN, IX_DUR_MAX, 600);
  return patchTrack0(raw, ctx, (t) => ({ ...t, dur }), track);
}
/**
 * Repetición de la pista 0. `1` es el valor inicial de CSS y se BORRA de la prop (mismo criterio
 * que el emisor, que omite las partes del atajo con su valor inicial): un bloque al que el autor
 * puso y quitó la repetición vuelve a sus bytes exactos.
 */
export function setRepeat(raw: unknown, rep: number | "inf", ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    const next: IxTrack = { ...t };
    if (rep === "inf") next.repeat = "inf";
    else {
      const v = clampInput(Math.round(rep), 1, IX_REPEAT_MAX, 1);
      if (v <= 1) delete next.repeat;
      else next.repeat = v;
    }
    return next;
  }, track);
}
/** Ida y vuelta (`animation-direction: alternate`). `false` borra la clave. */
export function setAlternate(raw: unknown, alt: boolean, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    const next: IxTrack = { ...t };
    if (alt) next.alt = true;
    else delete next.alt;
    return next;
  }, track);
}
/**
 * Opciones de pista de P3. Se escriben tal cual y el normalizador BORRA los valores por defecto
 * ("right" / "center" / 1000) en `write()`: la ausencia es el defecto y los bytes de origen se
 * conservan sin que cada escritor repita la regla.
 */
export function setClipDir(raw: unknown, dir: IxClipDir, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => ({ ...t, clipDir: dir }), track);
}
export function setOrigin(raw: unknown, origin: IxOrigin, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => ({ ...t, origin }), track);
}
export function setPersp(raw: unknown, px: number, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => ({ ...t, persp: px }), track);
}
export const IX_CLIP_DIR_LABELS: Readonly<Record<IxClipDir, string>> = Object.freeze({
  right: "Hacia la derecha",
  left: "Hacia la izquierda",
  down: "Hacia abajo",
  up: "Hacia arriba",
  "center-h": "Desde el centro (horizontal)",
  "center-v": "Desde el centro (vertical)",
});

export const IX_ORIGIN_LABELS: Readonly<Record<IxOrigin, string>> = Object.freeze({
  center: "Centro",
  top: "Arriba",
  bottom: "Abajo",
  left: "Izquierda",
  right: "Derecha",
  "top-left": "Arriba izquierda",
  "top-right": "Arriba derecha",
  "bottom-left": "Abajo izquierda",
  "bottom-right": "Abajo derecha",
});

export function setDelay(raw: unknown, ms: number, ctx?: IxCompileCtx, track = 0): IxWrite {
  const delay = clampInput(ms, IX_DELAY_MIN, IX_DELAY_MAX, 0);
  return patchTrack0(raw, ctx, (t) => ({ ...t, delay }), track);
}
const clampInput = (v: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback;

/* ------------------------------------------------------------------ */
/* Pasos                                                               */
/* ------------------------------------------------------------------ */

/**
 * Añadir un paso. Se inserta ANTES del último y a mitad de camino entre sus vecinos: el fotograma
 * final se queda donde estaba, así que añadir un paso nunca cambia dónde ACABA la animación (que es
 * la propiedad que el contrato de las entradas actuales protege a propósito — el `to` es neutro).
 */
export function addStep(raw: unknown, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (t.steps.length >= IX_MAX_STEPS) return t;
    const last = t.steps.length - 1;
    const at = Math.round((t.steps[last - 1].at + t.steps[last].at) / 2);
    const steps = [...t.steps.slice(0, last), blankStep(at), t.steps[last]];
    return { ...t, steps };
  }, track);
}
/** Quitar un paso. Los extremos no se quitan: una pista de 1 paso no interpola nada. */
export function removeStep(raw: unknown, index: number, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (t.steps.length <= 2) return t;
    if (index <= 0 || index >= t.steps.length - 1) return t;
    return { ...t, steps: t.steps.filter((_, i) => i !== index) };
  }, track);
}
/** Momento del paso (%). Los extremos los reancla el normalizador a 0 y 100: aquí no se discute. */
export function setStepAt(raw: unknown, index: number, at: number, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (index < 0 || index >= t.steps.length) return t;
    // ACOTADO ENTRE VECINOS, aquí y solo aquí: el normalizador ordena por `at` y DEDUPLICA los
    // iguales quedándose con el primero, así que un paso que alcanza el `at` de su vecino lo BORRA
    // del documento con sus props y su curva — pérdida de datos por un gesto rutinario (arrastre,
    // flechas o el campo numérico, todos pasan por este escritor). Los extremos no se acotan: el
    // normalizador ya los reancla a 0/100. Sin hueco entre vecinos, no se escribe nada.
    const isInner = index > 0 && index < t.steps.length - 1;
    const lo = isInner ? t.steps[index - 1].at + 1 : 0;
    const hi = isInner ? t.steps[index + 1].at - 1 : 100;
    if (lo > hi) return t;
    const value = clampInput(Math.round(at), lo, hi, t.steps[index].at);
    return { ...t, steps: t.steps.map((s, i) => (i === index ? { ...s, at: value } : s)) };
  }, track);
}
/** Curva DE ESTE PASO AL SIGUIENTE. En el último no significa nada y el emisor la ignora. */
export function setStepEase(raw: unknown, index: number, ease: IxEase, ctx?: IxCompileCtx, track = 0): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (index < 0 || index >= t.steps.length) return t;
    // Elegir un NOMBRE retira la curva propia: el panel enseña una sola verdad por paso.
    return {
      ...t,
      steps: t.steps.map((s, i) => {
        if (i !== index) return s;
        const next: IxStep = { ...s, ease };
        delete next.bez;
        return next;
      }),
    };
  }, track);
}
/**
 * Curva PROPIA del paso (cubic-bezier como 4 números). `null` la quita y el paso vuelve a su
 * nombre de curva (o a ninguno). El clamp fino (X a 0..1, Y a ±4) lo hace el normalizador en
 * `write()` — aquí solo se decide la forma.
 */
export function setStepBez(
  raw: unknown,
  index: number,
  bez: [number, number, number, number] | null,
  ctx?: IxCompileCtx,
  track = 0,
): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (index < 0 || index >= t.steps.length) return t;
    return {
      ...t,
      steps: t.steps.map((s, i) => {
        if (i !== index) return s;
        const next: IxStep = { ...s };
        if (bez === null) delete next.bez;
        else next.bez = bez;
        return next;
      }),
    };
  }, track);
}
/**
 * Valor de UNA de las 8 propiedades en UN paso. `undefined` la quita del paso.
 *
 * No se propaga a los demás pasos: el compilador ya rellena la unión de propiedades de la pista con
 * el valor NEUTRO en cada fotograma, así que "poner `y` solo en el paso 0" significa exactamente
 * "de 24px a 0", que es lo que el autor acaba de pedir.
 */
export function setStepProp(
  raw: unknown,
  index: number,
  key: IxPropKey,
  value: number | undefined,
  ctx?: IxCompileCtx,
  track = 0,
): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (index < 0 || index >= t.steps.length) return t;
    return {
      ...t,
      steps: t.steps.map((s, i) => {
        if (i !== index) return s;
        const set: IxProps = { ...s.set };
        if (value === undefined || !Number.isFinite(value)) delete set[key];
        else set[key] = value;
        return { ...s, set };
      }),
    };
  }, track);
}
/**
 * El COLOR DEL TEMA de una propiedad de color en un paso (C4). `undefined` lo quita y devuelve el
 * paso al color literal que ya tuviera.
 *
 * El token vive en su propia clave (`tint`) y no pisa el número de `set`: quitar el token deja el
 * hex intacto debajo, que es lo que el autor espera al probar "a ver cómo queda con el color del
 * tema" y volver atrás. Cuando hay token, MANDA el token (así lo decide el compilador).
 */
export function setStepTint(
  raw: unknown,
  index: number,
  key: IxColorPropKey,
  token: IxColorToken | undefined,
  ctx?: IxCompileCtx,
  track = 0,
): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (index < 0 || index >= t.steps.length) return t;
    return {
      ...t,
      steps: t.steps.map((s, i) => {
        if (i !== index) return s;
        const next: IxStep = { ...s };
        const tint = { ...(s.tint ?? {}) };
        if (token === undefined) delete tint[key];
        else tint[key] = token;
        if (Object.keys(tint).length === 0) delete next.tint;
        else next.tint = tint;
        return next;
      }),
    };
  }, track);
}

/** Propiedades que el paso NO tiene todavía — las que ofrece el desplegable "Añadir propiedad". */
export function availableProps(step: IxStep): IxPropKey[] {
  const used = new Set(usedProps(step));
  return IX_PROP_KEYS.filter((k) => !used.has(k));
}

/**
 * Propiedades presentes en el paso, en el ORDEN CANÓNICO (nunca el de inserción del objeto).
 *
 * Una propiedad de color con SOLO token (sin número debajo) también está presente: el compilador la
 * emite, así que el panel tiene que enseñarla o el autor no podría quitar lo que ya ve moverse.
 */
export function usedProps(step: IxStep): IxPropKey[] {
  return IX_PROP_KEYS.filter(
    (k) => step.set[k] !== undefined || step.tint?.[k as IxColorPropKey] !== undefined,
  );
}
