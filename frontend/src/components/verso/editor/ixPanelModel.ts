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
  IX_DEFAULT_RANGES,
  IX_DELAY_MAX,
  IX_DELAY_MIN,
  IX_DUR_MAX,
  IX_DUR_MIN,
  IX_MAX_STEPS,
  IX_PROP_KEYS,
  IX_REPEAT_MAX,
  IX_STAGGER_MAX,
  normalizeIxSpec,
  resolveIxBody,
  type IxCompileCtx,
  type IxEase,
  type IxEdgeName,
  type IxPreset,
  type IxPropKey,
  type IxProps,
  type IxRange,
  type IxSpec,
  type IxStep,
  type IxTarget,
  type IxTrack,
  type IxTrigger,
} from "@/lib/verso/interactions";

/* ------------------------------------------------------------------ */
/* Vocabulario del panel (el DATO no se traduce; la UI sí)             */
/* ------------------------------------------------------------------ */

export type IxPanelTriggerKind = IxTrigger["on"];
/** El panel no ofrece `block` (objetivo externo): sin `timeline-scope` sería siempre runtime. */
export type IxPanelTargetKind = "self" | "children" | "words";

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
});

export const IX_TARGET_LABELS: Readonly<Record<IxPanelTargetKind, string>> = Object.freeze({
  self: "Este bloque",
  children: "Sus hijos",
  words: "Las palabras",
});

export const IX_EASE_LABELS: Readonly<Record<IxEase, string>> = Object.freeze({
  linear: "Constante",
  in: "Acelera",
  out: "Frena",
  "in-out": "Suave",
  spring: "Muelle",
  back: "Impulso",
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
});

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
      return write({ v: 1, trigger: state.trigger, tracks: state.tracks });
    }
    return write(defaultIxSpec());
  }
  // Enlazar a un preset: el bloque guarda un ID y NADA MÁS (ni una copia del cuerpo). Un `trigger`
  // propio anterior se descarta a propósito: el preajuste trae el suyo, y conservar el viejo haría
  // que elegir un preset diese un resultado distinto según lo que hubiera antes.
  return write({ v: 1, preset: choice });
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
            : { on: "load" };

  if (state.presetId !== null) return write({ v: 1, preset: state.presetId, trigger });
  const body = ownBody(raw, ctx);
  return write({ v: 1, trigger, tracks: body.tracks });
}

/**
 * Escribir un disparador nuevo conservando la naturaleza del cuerpo: el override de `trigger` es lo
 * ÚNICO que un bloque enlazado a un preajuste puede llevar, así que la propagación sigue intacta.
 */
function writeTrigger(raw: unknown, ctx: IxCompileCtx | undefined, trigger: IxTrigger): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.presetId !== null) return write({ v: 1, preset: state.presetId, trigger });
  const body = ownBody(raw, ctx);
  return write({ v: 1, trigger, tracks: body.tracks });
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

/** `scrub`: el progreso lo marca el recorrido del bloque (`self`) o el scroll de la página. */
export function setScrubSrc(raw: unknown, src: "self" | "page", ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (state.trigger.on !== "scrub") return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger = { on: "scrub" };
  if (src === "page") trigger.src = "page";
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
      ? { on: "scrub", range, ...(state.trigger.src === "page" ? { src: "page" as const } : {}) }
      : { on: "view", once: false, range };
  return writeTrigger(raw, ctx, trigger);
}

/** Volver al rango por defecto: se BORRA el del autor (ausencia = defecto del compilador). */
export function resetRange(raw: unknown, ctx?: IxCompileCtx): IxWrite {
  const state = ixPanelState(raw, ctx);
  if (!rangeEditable(state.trigger)) return normalizeIxSpec(raw)?.spec;
  const trigger: IxTrigger =
    state.trigger.on === "scrub"
      ? { on: "scrub", ...(state.trigger.src === "page" ? { src: "page" as const } : {}) }
      : { on: "view", once: false };
  return writeTrigger(raw, ctx, trigger);
}

/**
 * Patch de la pista 0 (la única que el panel edita) conservando el resto tal cual.
 *
 * Escribe SIEMPRE un cuerpo propio. Si el bloque estaba enlazado a un preajuste, tocar un paso lo
 * DESVINCULA (copiando el cuerpo resuelto): es la única salida coherente, porque un `tracks` junto
 * a un `preset` sería una bifurcación silenciosa que rompe la propagación. El panel no ofrece ese
 * camino —con un preajuste puesto los pasos se muestran en solo lectura y hay un botón
 * "Desvincular"—, pero el modelo no puede devolver algo incoherente si alguien lo llama igual.
 */
function patchTrack0(
  raw: unknown,
  ctx: IxCompileCtx | undefined,
  patch: (track: IxTrack) => IxTrack | null,
): IxWrite {
  const body = ownBody(raw, ctx);
  const next = patch(body.tracks[0]);
  const tracks = next === null ? body.tracks.slice(1) : [next, ...body.tracks.slice(1)];
  if (tracks.length === 0) return undefined;
  return write({ v: 1, trigger: body.trigger, tracks });
}

export function setTargetKind(raw: unknown, kind: IxPanelTargetKind, ctx?: IxCompileCtx): IxWrite {
  const target: IxTarget = { kind };
  return patchTrack0(raw, ctx, (t) => ({ ...t, target }));
}

/** Escalonado entre hermanos (ms). 0 lo quita. */
export function setStagger(raw: unknown, each: number, ctx?: IxCompileCtx): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (!Number.isFinite(each) || each <= 0) {
      const next: IxTrack = { ...t };
      delete next.stagger;
      return next;
    }
    return { ...t, stagger: { ...(t.stagger ?? {}), each: Math.min(each, IX_STAGGER_MAX) } };
  });
}

export function setDuration(raw: unknown, ms: number, ctx?: IxCompileCtx): IxWrite {
  const dur = clampInput(ms, IX_DUR_MIN, IX_DUR_MAX, 600);
  return patchTrack0(raw, ctx, (t) => ({ ...t, dur }));
}

/**
 * Repetición de la pista 0. `1` es el valor inicial de CSS y se BORRA de la prop (mismo criterio
 * que el emisor, que omite las partes del atajo con su valor inicial): un bloque al que el autor
 * puso y quitó la repetición vuelve a sus bytes exactos.
 */
export function setRepeat(raw: unknown, rep: number | "inf", ctx?: IxCompileCtx): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    const next: IxTrack = { ...t };
    if (rep === "inf") next.repeat = "inf";
    else {
      const v = clampInput(Math.round(rep), 1, IX_REPEAT_MAX, 1);
      if (v <= 1) delete next.repeat;
      else next.repeat = v;
    }
    return next;
  });
}

/** Ida y vuelta (`animation-direction: alternate`). `false` borra la clave. */
export function setAlternate(raw: unknown, alt: boolean, ctx?: IxCompileCtx): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    const next: IxTrack = { ...t };
    if (alt) next.alt = true;
    else delete next.alt;
    return next;
  });
}

export function setDelay(raw: unknown, ms: number, ctx?: IxCompileCtx): IxWrite {
  const delay = clampInput(ms, IX_DELAY_MIN, IX_DELAY_MAX, 0);
  return patchTrack0(raw, ctx, (t) => ({ ...t, delay }));
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
export function addStep(raw: unknown, ctx?: IxCompileCtx): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (t.steps.length >= IX_MAX_STEPS) return t;
    const last = t.steps.length - 1;
    const at = Math.round((t.steps[last - 1].at + t.steps[last].at) / 2);
    const steps = [...t.steps.slice(0, last), blankStep(at), t.steps[last]];
    return { ...t, steps };
  });
}

/** Quitar un paso. Los extremos no se quitan: una pista de 1 paso no interpola nada. */
export function removeStep(raw: unknown, index: number, ctx?: IxCompileCtx): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (t.steps.length <= 2) return t;
    if (index <= 0 || index >= t.steps.length - 1) return t;
    return { ...t, steps: t.steps.filter((_, i) => i !== index) };
  });
}

/** Momento del paso (%). Los extremos los reancla el normalizador a 0 y 100: aquí no se discute. */
export function setStepAt(raw: unknown, index: number, at: number, ctx?: IxCompileCtx): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (index < 0 || index >= t.steps.length) return t;
    const value = clampInput(Math.round(at), 0, 100, t.steps[index].at);
    return { ...t, steps: t.steps.map((s, i) => (i === index ? { ...s, at: value } : s)) };
  });
}

/** Curva DE ESTE PASO AL SIGUIENTE. En el último no significa nada y el emisor la ignora. */
export function setStepEase(raw: unknown, index: number, ease: IxEase, ctx?: IxCompileCtx): IxWrite {
  return patchTrack0(raw, ctx, (t) => {
    if (index < 0 || index >= t.steps.length) return t;
    return { ...t, steps: t.steps.map((s, i) => (i === index ? { ...s, ease } : s)) };
  });
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
  });
}

/** Propiedades que el paso NO tiene todavía — las que ofrece el desplegable "Añadir propiedad". */
export function availableProps(step: IxStep): IxPropKey[] {
  return IX_PROP_KEYS.filter((k) => step.set[k] === undefined);
}

/** Propiedades presentes en el paso, en el ORDEN CANÓNICO (nunca el de inserción del objeto). */
export function usedProps(step: IxStep): IxPropKey[] {
  return IX_PROP_KEYS.filter((k) => step.set[k] !== undefined);
}
