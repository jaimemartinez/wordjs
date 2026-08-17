/**
 * Verso — interacciones: VALIDADOR / NORMALIZADOR.
 *
 * `_puck_data` es dato controlado por el AUTOR y, peor, puede llegar por la API o por una
 * importación WXR: hay que tratarlo como hostil. Mismo criterio que `clampAnimSpec` con `anim`
 * (que clampa duration/delay en la frontera de escritura Y en el render), llevado hasta el final.
 *
 * LA INVARIANTE, y por qué se sostiene por construcción y no por disciplina:
 *
 *   NINGUNA cadena del autor llega jamás al CSS.
 *
 * Todo lo que el compilador escribe en una hoja de estilos es (a) un NÚMERO que este módulo ha
 * clampado y que el emisor formatea él mismo, (b) un token de una lista CERRADA declarada aquí
 * (`IX_EASINGS`, `IX_EDGE_NAMES`, `on`, `kind`…), o (c) el hash, que es base36 por construcción.
 * Un valor como `1px} body{display:none` o `url(javascript:alert(1))` no tiene ningún camino
 * hasta el emisor: o es un número (y `Number("1px}…")` es `NaN` → se descarta), o no está en la
 * lista cerrada (→ se descarta). No hay escapado que revisar porque no hay interpolación que
 * escapar.
 *
 * FAIL-OPEN SIEMPRE: cuando algo no se entiende, se DESCARTA esa parte y el bloque se renderiza
 * visible y quieto. La única forma de fallar es no moverse — nunca contenido oculto, nunca una
 * página rota. Por eso `normalizeIxSpec` devuelve `null` en vez de lanzar.
 */
import type {
  IxEase,
  IxEdge,
  IxEdgeName,
  IxPreset,
  IxProps,
  IxPropKey,
  IxRange,
  IxSpec,
  IxStagger,
  IxStaggerFrom,
  IxStep,
  IxTarget,
  IxTrack,
  IxTrigger,
} from "./types";

/* ------------------------------------------------------------------ */
/* Topes (§6.2 de la spec) — superarlos AVISA, jamás rompe el render.  */
/* ------------------------------------------------------------------ */

/** 3 pistas es donde el autor deja de poder razonar sobre qué se mueve a la vez. */
export const IX_MAX_TRACKS = 3;
/** 6 pasos es donde la tira deja de caber en el panel — y una entrada con 7 puntos no es una entrada. */
export const IX_MAX_STEPS = 6;
/** Tope de reglas `:nth-child()` generadas; del 24.º en adelante todos comparten su retardo. */
export const IX_MAX_CHILDREN = 24;
/** Máximo de palabras del split; a partir de ahí no se parte (fail-open al texto normal). */
export const IX_MAX_WORDS = 40;
/** Presupuesto de bytes de §7.3 traducido a unidades. */
export const IX_MAX_UNITS_PER_PAGE = 30;

/* ------------------------------------------------------------------ */
/* Clamps temporales — MISMOS límites que AnimSpec (100–3000 / 0–3000) */
/* ------------------------------------------------------------------ */

/**
 * Deliberadamente idénticos a ANIM_DURATION_MIN/MAX y ANIM_DELAY_MIN/MAX de
 * `lib/verso/sharedFields.tsx`. NO se importan de allí: ese módulo es `"use client"` y este tiene
 * que poder compilarse en el servidor y en un test de node. Si algún día cambian, cambian los dos.
 */
export const IX_DUR_MIN = 100;
export const IX_DUR_MAX = 3000;
export const IX_DELAY_MIN = 0;
export const IX_DELAY_MAX = 3000;
/** Retardo entre hermanos del stagger (ms). */
export const IX_STAGGER_MAX = 1000;
/** Repeticiones finitas. `"inf"` es un token aparte. */
export const IX_REPEAT_MAX = 50;

export const IX_DEFAULT_DUR = 600;
export const IX_DEFAULT_DELAY = 0;

/* ------------------------------------------------------------------ */
/* Listas CERRADAS                                                     */
/* ------------------------------------------------------------------ */

/**
 * Muestreo de una física a `linear()`. Puntos EQUIDISTANTES a propósito: la sintaxis permite
 * omitir los porcentajes cuando los puntos se reparten uniformes, y eso deja la curva en ~6 bytes
 * por punto. Redondeo a 3 decimales: mata el ruido de último bit de `Math.sin`/`pow` entre motores
 * de JS, así que el texto emitido es estable byte a byte también entre versiones de node.
 */
function sampleLinear(fn: (t: number) => number, n: number): string {
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    pts.push(String(Math.round(fn(i / n) * 1000) / 1000));
  }
  return `linear(${pts.join(",")})`;
}

/** easeOutBounce clásico (parábolas a trozos, 4 rebotes). */
const bounceOut = (t: number): number => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

/** easeOutElastic clásico (seno amortiguado, se asienta en 1). */
const elasticOut = (t: number): number =>
  t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;

/**
 * Easings. El autor elige un NOMBRE; la curva la pone esta tabla. `out` es exactamente la curva
 * que usan hoy las entradas de `wordjs-ui.css` (`cubic-bezier(0.16, 1, 0.3, 1)`), para que un
 * preset de sistema recorra el mismo camino visual que su clase estática.
 *
 * `bounce` y `elastic` son FÍSICAS compiladas a `linear()` (P2 del scorecard): la simulación corre
 * aquí, una vez; el navegador solo interpola una lista de puntos. Es lo que IX3 hace con GSAP en el
 * hilo principal del visitante, hecho gratis en compilación. El rebote lleva 32 puntos (sus picos
 * son estrechos); el elástico con 24 va sobrado.
 */
export const IX_EASINGS: Readonly<Record<IxEase, string>> = Object.freeze({
  linear: "linear",
  in: "cubic-bezier(.4,0,1,1)",
  out: "cubic-bezier(.16,1,.3,1)",
  "in-out": "cubic-bezier(.65,0,.35,1)",
  spring: "cubic-bezier(.34,1.56,.64,1)",
  back: "cubic-bezier(.68,-.55,.27,1.55)",
  bounce: sampleLinear(bounceOut, 32),
  elastic: sampleLinear(elasticOut, 24),
});

const IX_EASE_KEYS = Object.keys(IX_EASINGS) as IxEase[];

/**
 * Topes del bezier propio: las X son abscisas de una curva de Bézier de easing y el estándar exige
 * 0..1; las Y admiten rebasamiento (así se hace un overshoot) pero se acotan — un `y: 1e9` no "se
 * ve fuerte", rompe la interpolación. ±4 cubre cualquier curva que un humano quiera.
 */
export const IX_BEZ_Y_MAX = 4;

/** Los 4 números de un `cubic-bezier` del autor, clampados. `undefined` si no hay 4 números. */
function normBez(raw: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const nums = raw.map((v) => num(v));
  if (nums.some((v) => v === undefined)) return undefined;
  const [x1, y1, x2, y2] = nums as number[];
  return [
    clamp(x1, 0, 1),
    clamp(y1, -IX_BEZ_Y_MAX, IX_BEZ_Y_MAX),
    clamp(x2, 0, 1),
    clamp(y2, -IX_BEZ_Y_MAX, IX_BEZ_Y_MAX),
  ];
}

export const IX_EDGE_NAMES: readonly IxEdgeName[] = Object.freeze([
  "cover",
  "contain",
  "entry",
  "exit",
]);

/**
 * ORDEN CANÓNICO de las 8 propiedades. Es un array explícito y no `Object.keys` de un objeto
 * literal: el orden de emisión de las declaraciones tiene que ser estable byte a byte, y no se va
 * a hacer depender de un detalle de motor.
 */
export const IX_PROP_KEYS: readonly IxPropKey[] = Object.freeze([
  "opacity",
  "x",
  "y",
  "scale",
  "rotate",
  "rotateX",
  "blur",
  "clip",
]);

/**
 * Rango de cada propiedad. Los topes no son cosméticos: `blur: 1e9` o `scale: 1e12` no "se ven
 * feos", tumban el compositor del navegador. Un `_puck_data` hostil no puede pedir eso.
 */
const IX_PROP_RANGE: Readonly<Record<IxPropKey, readonly [number, number]>> = Object.freeze({
  opacity: [0, 1],
  x: [-4000, 4000],
  y: [-4000, 4000],
  scale: [0, 10],
  rotate: [-3600, 3600],
  rotateX: [-3600, 3600],
  blur: [0, 100],
  clip: [0, 100],
});

/** Valor NEUTRO de cada propiedad: el estado en el que el bloque se ve como si no hubiera nada. */
export const IX_PROP_NEUTRAL: Readonly<Record<IxPropKey, number>> = Object.freeze({
  opacity: 1,
  x: 0,
  y: 0,
  scale: 1,
  rotate: 0,
  rotateX: 0,
  blur: 0,
  clip: 100,
});

/**
 * Ids de preset y de bloque. No llegan al CSS (la clase sale del hash), pero el id de bloque SÍ
 * llega a un selector de atributo del runtime y a un `data-*`, así que se acota igualmente:
 * defensa en profundidad, coste cero.
 */
const PRESET_ID_RE = /^(?:sys:)?[a-z0-9][a-z0-9_-]{0,63}$/;
const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * Número finito o `undefined`. Acepta SOLO `number`: una cadena `"12"` de un import podría
 * parecer inofensiva, pero admitirla abre la puerta a `"12px"`→NaN y a discutir después qué pasa
 * con `"1e400"`. El panel escribe números; lo demás se descarta.
 */
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/* ------------------------------------------------------------------ */
/* Normalizadores por pieza                                            */
/* ------------------------------------------------------------------ */

function normEdge(raw: unknown): IxEdge | undefined {
  if (!isObj(raw)) return undefined;
  const at = oneOf(raw.at, IX_EDGE_NAMES);
  const pct = num(raw.pct);
  if (at === undefined || pct === undefined) return undefined;
  return { at, pct: clamp(pct, 0, 100) };
}

function normRange(raw: unknown): IxRange | undefined {
  if (!isObj(raw)) return undefined;
  const from = normEdge(raw.from);
  const to = normEdge(raw.to);
  if (!from || !to) return undefined;
  return { from, to };
}

/** Las 8 propiedades, clampadas. Cualquier clave fuera de la lista se DESCARTA sin más. */
export function normProps(raw: unknown): IxProps {
  const out: IxProps = {};
  if (!isObj(raw)) return out;
  for (const k of IX_PROP_KEYS) {
    const n = num(raw[k]);
    if (n === undefined) continue;
    const [min, max] = IX_PROP_RANGE[k];
    out[k] = clamp(n, min, max);
  }
  return out;
}

function normStep(raw: unknown): IxStep | undefined {
  if (!isObj(raw)) return undefined;
  const at = num(raw.at);
  if (at === undefined) return undefined;
  const set = normProps(raw.set);
  const ease = oneOf(raw.ease, IX_EASE_KEYS);
  const step: IxStep = { at: clamp(at, 0, 100), set };
  if (ease) step.ease = ease;
  const bez = normBez(raw.bez);
  if (bez) step.bez = bez;
  return step;
}

/**
 * Los pasos de una pista, saneados a la forma que el emisor asume: ≥2, `at` estrictamente
 * creciente, primero 0 y último 100.
 *
 * TRUNCADO: cuando hay más de IX_MAX_STEPS se conservan los primeros N−1 y EL ÚLTIMO, no los
 * primeros N. Quedarse con los primeros dejaría la pista sin su fotograma final y el bloque
 * acabaría en un estado intermedio (el `to` dejaría de ser neutro) — exactamente el fallo que el
 * contrato de las entradas actuales evita a propósito.
 */
function normSteps(raw: unknown, warn: (w: string) => void): IxStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed: IxStep[] = [];
  for (const r of raw) {
    const s = normStep(r);
    if (s) parsed.push(s);
  }
  if (parsed.length < 2) return undefined;

  // Orden estable por `at` y deduplicación (el primero de cada `at` gana: determinista).
  parsed.sort((a, b) => a.at - b.at);
  const uniq: IxStep[] = [];
  for (const s of parsed) {
    if (uniq.length === 0 || uniq[uniq.length - 1].at !== s.at) uniq.push(s);
  }
  if (uniq.length < 2) return undefined;

  let steps = uniq;
  if (steps.length > IX_MAX_STEPS) {
    warn(`pista con ${steps.length} pasos: se emiten ${IX_MAX_STEPS} (tope IX_MAX_STEPS)`);
    steps = [...steps.slice(0, IX_MAX_STEPS - 1), steps[steps.length - 1]];
  }

  // Anclado de extremos. Puede colisionar con el 2.º/penúltimo paso si el autor puso 0 y 1:
  // se reancla y se vuelve a deduplicar para no emitir dos veces el mismo `%`.
  steps = steps.map((s, i) =>
    i === 0 ? { ...s, at: 0 } : i === steps.length - 1 ? { ...s, at: 100 } : s,
  );
  const anchored: IxStep[] = [];
  for (const s of steps) {
    if (anchored.length === 0 || anchored[anchored.length - 1].at !== s.at) anchored.push(s);
    else anchored[anchored.length - 1] = s; // el último que reclama un `at` gana tras el anclado
  }
  return anchored.length >= 2 ? anchored : undefined;
}

function normTarget(raw: unknown): IxTarget | undefined {
  if (!isObj(raw)) return undefined;
  const kind = raw.kind;
  if (kind === "self" || kind === "children" || kind === "words") return { kind };
  if (kind === "block") {
    const id = raw.id;
    if (typeof id === "string" && BLOCK_ID_RE.test(id)) return { kind: "block", id };
  }
  return undefined;
}

function normStagger(raw: unknown): IxStagger | undefined {
  if (!isObj(raw)) return undefined;
  const each = num(raw.each);
  if (each === undefined) return undefined;
  const from = oneOf<IxStaggerFrom>(raw.from, ["start", "end", "center"]);
  const st: IxStagger = { each: clamp(each, 0, IX_STAGGER_MAX) };
  if (from) st.from = from;
  return st;
}

function normTrack(raw: unknown, warn: (w: string) => void): IxTrack | undefined {
  if (!isObj(raw)) return undefined;
  const target = normTarget(raw.target);
  if (!target) return undefined;
  const steps = normSteps(raw.steps, warn);
  if (!steps) return undefined;

  // Una pista que no toca NINGUNA de las 8 propiedades no anima nada: se descarta antes de entrar
  // en el cuerpo. Si no, el emisor produciría `@keyframes n{0%{}100%{}}` y un `transition:` sin
  // valor — CSS inerte, pero ruido en la hoja y en el hash.
  if (!steps.some((s) => IX_PROP_KEYS.some((k) => s.set[k] !== undefined))) return undefined;

  const track: IxTrack = { target, steps };

  const dur = num(raw.dur);
  if (dur !== undefined) track.dur = clamp(dur, IX_DUR_MIN, IX_DUR_MAX);
  const delay = num(raw.delay);
  if (delay !== undefined) track.delay = clamp(delay, IX_DELAY_MIN, IX_DELAY_MAX);

  if (raw.repeat === "inf") track.repeat = "inf";
  else {
    const rep = num(raw.repeat);
    if (rep !== undefined) track.repeat = clamp(Math.round(rep), 1, IX_REPEAT_MAX);
  }

  if (raw.alt === true) track.alt = true;

  const stagger = normStagger(raw.stagger);
  if (stagger) track.stagger = stagger;

  return track;
}

export function normTracks(raw: unknown, warn: (w: string) => void): IxTrack[] {
  if (!Array.isArray(raw)) return [];
  const out: IxTrack[] = [];
  for (const r of raw) {
    const t = normTrack(r, warn);
    if (!t) continue;
    if (out.length >= IX_MAX_TRACKS) {
      warn(`pistas por encima del tope: se emiten ${IX_MAX_TRACKS} (tope IX_MAX_TRACKS)`);
      break;
    }
    out.push(t);
  }
  return out;
}

export function normTrigger(raw: unknown): IxTrigger | undefined {
  if (!isObj(raw)) return undefined;
  switch (raw.on) {
    case "view": {
      const t: IxTrigger = { on: "view" };
      if (raw.once === true) t.once = true;
      else if (raw.once === false) t.once = false;
      const range = normRange(raw.range);
      if (range) t.range = range;
      return t;
    }
    case "scrub": {
      const t: IxTrigger = { on: "scrub" };
      const range = normRange(raw.range);
      if (range) t.range = range;
      const src = oneOf(raw.src, ["self", "page"] as const);
      if (src) t.src = src;
      return t;
    }
    case "hover":
      return { on: "hover" };
    case "click": {
      const t: IxTrigger = { on: "click" };
      if (raw.toggle === true) t.toggle = true;
      return t;
    }
    case "load": {
      const t: IxTrigger = { on: "load" };
      const delay = num(raw.delay);
      if (delay !== undefined) t.delay = clamp(delay, IX_DELAY_MIN, IX_DELAY_MAX);
      return t;
    }
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* La frontera                                                         */
/* ------------------------------------------------------------------ */

export type IxNormalizeResult = { spec: IxSpec; warnings: string[] } | null;

/**
 * Normaliza la prop `ix` de un bloque. Devuelve `null` cuando no hay nada usable — el bloque se
 * renderiza sin interacción, VISIBLE (fail-open).
 *
 * `v` distinta de 1 → `null` sin mirar nada más: un lector viejo ignora un formato que no conoce
 * en vez de adivinar.
 * `preset` presente → `tracks` se DESCARTA (nunca coexisten: sería una bifurcación silenciosa que
 * rompe la propagación del preset).
 */
export function normalizeIxSpec(raw: unknown): IxNormalizeResult {
  if (!isObj(raw)) return null;
  if (raw.v !== 1) return null;

  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  const spec: IxSpec = { v: 1 };

  const preset = raw.preset;
  const hasPreset = typeof preset === "string" && PRESET_ID_RE.test(preset);
  if (typeof preset === "string" && !hasPreset) warn(`id de preset descartado: no es un slug válido`);

  const trigger = normTrigger(raw.trigger);
  if (trigger) spec.trigger = trigger;

  if (hasPreset) {
    spec.preset = preset;
    if (raw.tracks !== undefined) {
      warn("un bloque enlazado a un preset no puede llevar `tracks`: se descartan");
    }
  } else {
    const tracks = normTracks(raw.tracks, warn);
    if (tracks.length === 0) return null;
    spec.tracks = tracks;
  }

  return { spec, warnings };
}

/**
 * Normaliza un preset venido de ajustes del sitio (otro dato author-controlled). Un preset sin
 * pistas utilizables se descarta entero: una referencia rota deja el bloque visible y quieto.
 */
export function normalizeIxPreset(raw: unknown): IxPreset | null {
  if (!isObj(raw)) return null;
  const id = raw.id;
  if (typeof id !== "string" || !PRESET_ID_RE.test(id)) return null;
  const trigger = normTrigger(raw.trigger) ?? { on: "view", once: true };
  const tracks = normTracks(raw.tracks, () => {});
  if (tracks.length === 0) return null;
  const rev = num(raw.rev);
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    trigger,
    tracks,
    rev: rev === undefined ? 0 : Math.max(0, Math.round(rev)),
  };
}
