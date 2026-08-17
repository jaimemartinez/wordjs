/**
 * Verso — motor de interacciones (F9-A): EL MODELO.
 *
 * Contrato de `documentation/verso/interactions-spec.md`, transcrito a tipos. Este fichero NO tiene
 * `"use client"`, no importa React y no tiene dependencias: es dato puro, compartido por el
 * compilador, el runtime, el editor y el sitio público.
 *
 * DÓNDE VIVE EL DATO: una interacción es una PROP del bloque (`ix`), sin `defaultProps` — su
 * AUSENCIA es el valor, así que un bloque que nadie tocó tiene los mismos bytes en `_puck_data` hoy
 * y mañana (restricción dura 1). Los presets NO viajan en el documento: el bloque guarda un id.
 *
 * DÓNDE VIVE "CERO CLS": en `IxProps`. Es una lista CERRADA de 8 propiedades, todas de compositor
 * (transform / opacity / filter / clip-path). `width`, `height`, `top`, `margin`, `font-size`… no
 * son REPRESENTABLES, así que no hay nada que auditar en el compilador: lo que no está en el tipo
 * no puede llegar al CSS (restricción dura 3).
 */

/* ------------------------------------------------------------------ */
/* La prop del bloque                                                  */
/* ------------------------------------------------------------------ */

/**
 * Una interacción, serializable, en las props del bloque.
 *
 * `v` es la versión del formato: un lector con `v` desconocida IGNORA la interacción (fail-open —
 * la única forma de fallar es no moverse, nunca una página en blanco ni contenido oculto).
 * `preset` y `tracks` son EXCLUYENTES: un bloque enlazado a un preset puede sobreescribir su
 * `trigger` y nada más; para cambiar los pasos, el panel ofrece "Desvincular" (copia el cuerpo a
 * `tracks` y borra `preset`). Una bifurcación silenciosa rompería la propagación del preset.
 */
export type IxSpec = {
  v: 1;
  preset?: string;
  trigger?: IxTrigger;
  tracks?: IxTrack[];
};

/* ------------------------------------------------------------------ */
/* Disparador                                                          */
/* ------------------------------------------------------------------ */

export type IxTrigger =
  | { on: "view"; once?: boolean; range?: IxRange }
  | { on: "scrub"; range?: IxRange; src?: "self" | "page" }
  | { on: "hover" }
  | { on: "click"; toggle?: boolean }
  | { on: "load"; delay?: number };

/**
 * Mapea 1:1 a `animation-range`. Vocabulario de la especificación CSS SIN traducir (`cover 0%`,
 * `entry 100%`…): un modelo intermedio "amigable" habría que traducirlo en los dos sentidos y
 * perdería casos. El panel traduce a lenguaje de autor; el DATO no.
 */
export type IxRange = { from: IxEdge; to: IxEdge };
export type IxEdge = { at: IxEdgeName; pct: number };
export type IxEdgeName = "cover" | "contain" | "entry" | "exit";

/* ------------------------------------------------------------------ */
/* Pistas y pasos                                                      */
/* ------------------------------------------------------------------ */

export type IxTrack = {
  target: IxTarget;
  /** ≥2 pasos, `at` estrictamente creciente, primero 0 y último 100. Máx. IX_MAX_STEPS. */
  steps: IxStep[];
  /** ms — solo disparadores temporales (load / hover / click / view+once). */
  dur?: number;
  delay?: number;
  repeat?: number | "inf";
  /** `animation-direction: alternate`. */
  alt?: boolean;
  stagger?: IxStagger;
};

export type IxStagger = { each: number; from?: IxStaggerFrom };
export type IxStaggerFrom = "start" | "end" | "center";

export type IxStep = {
  /** 0..100 — % de la pista (tiempo o rango de scroll: el MISMO eje). */
  at: number;
  set: IxProps;
  /** Easing DE ESTE PASO AL SIGUIENTE; se emite en el selector del paso. Ignorado en el último. */
  ease?: IxEase;
  /**
   * Curva PROPIA del autor: `cubic-bezier(x1,y1,x2,y2)`, como cuatro NÚMEROS (x clampada a 0..1,
   * y acotada — la invariante de que ninguna cadena del autor llega al CSS se mantiene: el emisor
   * formatea él mismo los cuatro escalares). Si está, gana a `ease`.
   */
  bez?: [number, number, number, number];
};

/**
 * `bounce` y `elastic` no son beziers: son físicas muestreadas a `linear()` en COMPILACIÓN
 * (Baseline: Chrome 113 / Firefox 112 / Safari 17.2). Cero JS en reproducción — la física corre
 * una vez, en el compilador.
 */
export type IxEase = "linear" | "in" | "out" | "in-out" | "spring" | "back" | "bounce" | "elastic";

/**
 * LISTA CERRADA — aquí vive "cero CLS". Ocho propiedades, todas de compositor.
 * Ninguna causa reflow; ninguna acepta una cadena del autor (todas son NÚMEROS, y el emisor los
 * formatea él mismo), así que no existe un camino por el que un valor hostil llegue al CSS.
 */
export type IxProps = Partial<{
  /** 0..1 */
  opacity: number;
  /** px → translate3d */
  x: number;
  /** px → translate3d */
  y: number;
  /** 1 = neutro */
  scale: number;
  /** deg (Z) */
  rotate: number;
  /** deg (X) — el compilador añade `perspective()` a la MISMA declaración transform */
  rotateX: number;
  /** px → filter: blur() */
  blur: number;
  /** 0..100 % de revelado → clip-path: inset() */
  clip: number;
}>;

export type IxPropKey = keyof IxProps;

/* ------------------------------------------------------------------ */
/* Objetivo                                                            */
/* ------------------------------------------------------------------ */

export type IxTarget =
  | { kind: "self" }
  /** Hijos DIRECTOS del bloque (el caso del stagger). */
  | { kind: "children" }
  /** Solo bloques que declaren soporte de split por palabras (F9-D). */
  | { kind: "words" }
  /** Otro bloque, por `props.id`. Siempre `needsRuntime: "always"` en F9-A/B. */
  | { kind: "block"; id: string };

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Un preset vive en AJUSTES DEL SITIO (`wjs_ix_presets`), nunca en el tema (un tema es su contrato
 * de tokens y nada más, y jamás debe decidir CUÁNDO se mueve el contenido) ni en el documento
 * (editarlo reescribiría N documentos). El bloque guarda un ID; editar el preset no toca un byte
 * de `_puck_data`.
 */
export type IxPreset = {
  /** Slug estable: "aparecer-tarjetas". Los del sistema van prefijados `sys:`. */
  id: string;
  name: string;
  trigger: IxTrigger;
  tracks: IxTrack[];
  /** Entero monótono. Entra en el hash del CSS para invalidar el caché del navegador. */
  rev: number;
};

/* ------------------------------------------------------------------ */
/* IR compilado                                                        */
/* ------------------------------------------------------------------ */

/**
 * Cuánto JavaScript necesita una unidad:
 *  - `never`      → el CSS lo hace TODO, en todos los navegadores. Cero bytes de motor.
 *  - `no-native`  → el CSS lo hace en navegadores con `animation-timeline`; en los demás (Firefox
 *                   estable, agosto 2026) hace falta el driver de scrub.
 *  - `always`     → el CSS no puede expresarlo en ningún navegador (latch de "una sola vez", clic,
 *                   objetivo externo): la isla de eventos siempre.
 */
export type IxNeedsRuntime = "never" | "always" | "no-native";

/**
 * Un fotograma en forma WAAPI (estructuralmente un `Keyframe` del DOM, declarado aquí para que el
 * módulo no dependa de `lib.dom`). Lo consumen tres clientes: el fallback de Firefox, el scrubber
 * del panel y los tests de paridad — ese es el motivo de que el IR exista.
 */
export type IxKeyframe = {
  offset: number;
  easing?: string;
  opacity?: string;
  transform?: string;
  filter?: string;
  clipPath?: string;
};

/** El cuerpo NORMALIZADO de una interacción: lo único que entra en el hash. */
export type IxBody = {
  trigger: IxTrigger;
  tracks: IxTrack[];
  /** `rev` del preset del que salió, si salió de uno. Cambiarlo cambia el hash → invalida caché. */
  rev?: number;
};

export type IxUnit = {
  /** 7 chars base36 de FNV-1a 32 sobre el JSON canónico del cuerpo. */
  hash: string;
  /** `wjs-ix-<hash>` — la clase que estampa el bloque. */
  cls: string;
  body: IxBody;
  /** Reglas CSS listas (sin la envoltura `@media` — la pone `ixCss`). */
  rules: string[];
  /** Texto de los `@keyframes` (mismo criterio que `rules`). */
  keyframes: string[];
  /** nombre → fotogramas, para el backend WAAPI. */
  kf: Record<string, IxKeyframe[]>;
  needsRuntime: IxNeedsRuntime;
  /** Topes superados y capacidades no expresables: NUNCA rompen el render, se avisan. */
  warnings: string[];
};

/** Lo que el runtime necesita de una unidad. Serializable: viaja como JSON a la isla. */
export type IxRuntimeTrack = {
  kf: IxKeyframe[];
  target: IxTarget;
  range: IxRange;
  dur: number;
  delay: number;
  repeat: number | "inf";
  alt: boolean;
  stagger?: Required<IxStagger>;
};

export type IxRuntimeUnit = {
  cls: string;
  needsRuntime: IxNeedsRuntime;
  trigger: IxTrigger;
  tracks: IxRuntimeTrack[];
};

/** Salida de la compilación de UNA página: lo que consumen las tres superficies de emisión. */
export type IxPage = {
  /** Unidades ÚNICAS (deduplicadas por cuerpo), en orden determinista. */
  units: IxUnit[];
  /** El texto CSS de la página. Byte-estable entre ejecuciones. */
  css: string;
  /** Solo las unidades con `needsRuntime !== "never"`. Vacío ⇒ la página no carga NADA. */
  runtime: IxRuntimeUnit[];
  /** JSON canónico del cuerpo → clase final (con sufijo de colisión si lo hubo). */
  classByBody: Map<string, string>;
  warnings: string[];
};
