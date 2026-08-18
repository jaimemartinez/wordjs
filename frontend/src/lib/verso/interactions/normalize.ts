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
  IxBreakpoint,
  IxClipDir,
  IxColorPropKey,
  IxColorToken,
  IxEase,
  IxEdge,
  IxEdgeName,
  IxOrigin,
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
/** Columnas del stagger en rejilla (P4). */
export const IX_STAGGER_COLS_MIN = 2;
export const IX_STAGGER_COLS_MAX = 12;
/**
 * Hermanos SUPUESTOS por el fallback del modo tiempo-total cuando no hay `sibling-count()`
 * (Firefox estable): el reparto exacto necesita contar, y 8 tarjetas es el caso típico de una
 * rejilla de contenido. El camino nativo y el runtime WAAPI son exactos; esto solo acota el error
 * del único camino que no puede contar. Documentado, no silencioso: el compilador avisa.
 */
export const IX_STAGGER_TOTAL_FALLBACK_N = 8;
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

/** Direcciones del revelado de `clip` (P3). "right" (recortar el borde final) es la de siempre. */
export const IX_CLIP_DIRS: readonly IxClipDir[] = Object.freeze([
  "left",
  "right",
  "up",
  "down",
  "center-h",
  "center-v",
]);

/** `transform-origin` de lista cerrada (P3). El dato jamás lleva una cadena libre del autor. */
export const IX_ORIGINS: readonly IxOrigin[] = Object.freeze([
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

/** Perspectiva 3D por pista (P3). 1000 es lo que rotateX ya emitía antes de ser configurable. */
export const IX_PERSP_MIN = 200;
export const IX_PERSP_MAX = 4000;
export const IX_PERSP_DEFAULT = 1000;

/** Intensidad por bloque (P7): multiplica la distancia al neutro de las propiedades espaciales. */
export const IX_AMT_MIN = 0.1;
export const IX_AMT_MAX = 3;

/**
 * Nombre del evento a medida (P11). Slug corto y cerrado: viaja a un `addEventListener` con el
 * prefijo `wjs:ix:` y a un atributo del panel — nunca al CSS.
 */
export const IX_EVENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Prefijo del evento del documento que arma un disparador `event` (P11). */
export const IX_EVENT_PREFIX = "wjs:ix:";

/** Persecución del puntero (P6): ms de suavizado del cursor. 120 se siente "vivo" sin ir a rastras. */
export const IX_POINTER_SMOOTH_MAX = 1000;
export const IX_POINTER_SMOOTH_DEFAULT = 120;

/** Breakpoints del gating responsive (P4), en orden canónico. Los px viven en el compilador. */
export const IX_BREAKPOINTS: readonly IxBreakpoint[] = Object.freeze([
  "mobile",
  "tablet",
  "desktop",
]);

/**
 * ORDEN CANÓNICO de las propiedades. Es un array explícito y no `Object.keys` de un objeto
 * literal: el orden de emisión de las declaraciones tiene que ser estable byte a byte, y no se va
 * a hacer depender de un detalle de motor. Las 8 ORIGINALES van primero y en su orden de siempre:
 * cualquier `_puck_data` anterior a P3 emite bytes idénticos a los de antes de P3.
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
  // P3 — transform:
  "z",
  "scaleX",
  "scaleY",
  "rotateY",
  "skewX",
  "skewY",
  // P3 — filter:
  "brightness",
  "contrast",
  "saturate",
  "grayscale",
  "hue",
  // P3 — colores (pintado):
  "textColor",
  "bgColor",
  "borderColor",
  // P12 — trazo SVG (geometría del dash, no caja):
  "draw",
]);

/**
 * Rango de cada propiedad. Los topes no son cosméticos: `blur: 1e9` o `scale: 1e12` no "se ven
 * feos", tumban el compositor del navegador. Un `_puck_data` hostil no puede pedir eso.
 * `skew` se corta en ±89: 90° degenera la matriz. Los colores son un entero 0xRRGGBB.
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
  z: [-2000, 2000],
  scaleX: [0, 10],
  scaleY: [0, 10],
  rotateY: [-3600, 3600],
  skewX: [-89, 89],
  skewY: [-89, 89],
  brightness: [0, 10],
  contrast: [0, 10],
  saturate: [0, 10],
  grayscale: [0, 100],
  hue: [-360, 360],
  draw: [0, 100],
  textColor: [0, 0xffffff],
  bgColor: [0, 0xffffff],
  borderColor: [0, 0xffffff],
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
  z: 0,
  scaleX: 1,
  scaleY: 1,
  rotateY: 0,
  skewX: 0,
  skewY: 0,
  brightness: 1,
  contrast: 1,
  saturate: 1,
  grayscale: 0,
  hue: 0,
  draw: 100,
  // Los colores NO tienen neutro real (el "neutro" es el color propio del bloque, que el
  // compilador no conoce): estos valores existen para completar la tabla, pero el emisor NUNCA
  // los usa — los colores quedan fuera del relleno de la unión (IX_PROPS_NO_FILL).
  textColor: 0,
  bgColor: 0,
  borderColor: 0,
});

/**
 * Propiedades EXCLUIDAS del relleno neutro de la unión. Para un color, "no declarado en este paso"
 * significa "el color natural del bloque en ese punto", y eso solo puede expresarse OMITIENDO la
 * propiedad del fotograma: el navegador interpola desde el estilo computado, que es exactamente la
 * semántica que el autor pidió. Rellenar con un color fijo animaría hacia un color inventado.
 */
export const IX_PROPS_NO_FILL: ReadonlySet<IxPropKey> = new Set<IxPropKey>([
  "textColor",
  "bgColor",
  "borderColor",
]);

/** Las tres claves de color, en orden canónico — el orden de emisión también sale de aquí. */
export const IX_COLOR_PROP_KEYS: readonly IxColorPropKey[] = Object.freeze([
  "textColor",
  "bgColor",
  "borderColor",
]);

/**
 * Tokens del TEMA que un paso puede tomar prestados (C4). Lista CERRADA: el autor elige un rol y
 * el emisor escribe `var(--wjs-color-<token>)`, así que recolorear el sitio recolorea también sus
 * animaciones — y ninguna cadena del autor llega nunca a la hoja.
 */
export const IX_COLOR_TOKENS: readonly IxColorToken[] = Object.freeze([
  "primary",
  "secondary",
  "accent",
  "success",
  "danger",
  "warning",
  "info",
  "heading",
  "link",
]);

/** Los colores se REDONDEAN a entero al normalizar (un 0xRRGGBB con decimales no es un color). */
const IX_PROPS_INT: ReadonlySet<IxPropKey> = new Set<IxPropKey>([
  "textColor",
  "bgColor",
  "borderColor",
]);

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

/** Las propiedades de la lista cerrada, clampadas. Cualquier clave fuera se DESCARTA sin más. */
export function normProps(raw: unknown): IxProps {
  const out: IxProps = {};
  if (!isObj(raw)) return out;
  for (const k of IX_PROP_KEYS) {
    const n = num(raw[k]);
    if (n === undefined) continue;
    const [min, max] = IX_PROP_RANGE[k];
    const v = clamp(n, min, max);
    out[k] = IX_PROPS_INT.has(k) ? Math.round(v) : v;
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
  const tint = normTint(raw.tint);
  if (tint) step.tint = tint;
  return step;
}

/**
 * Los colores tomados del TEMA (C4): solo las tres claves de color, y solo nombres de la lista
 * cerrada. Cualquier otra clave o valor se DESCARTA en silencio, como el resto del normalizador —
 * y si no queda ninguno válido no se escribe la clave, para que el dato no engorde con `{}`.
 */
function normTint(raw: unknown): Partial<Record<IxColorPropKey, IxColorToken>> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Partial<Record<IxColorPropKey, IxColorToken>> = {};
  let any = false;
  for (const k of IX_COLOR_PROP_KEYS) {
    const tok = oneOf(raw[k], IX_COLOR_TOKENS);
    if (tok) {
      out[k] = tok;
      any = true;
    }
  }
  return any ? out : undefined;
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
  if (kind === "self" || kind === "children" || kind === "words" || kind === "svg") return { kind };
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
  // Con `total`, `each` es el tiempo del primero al último: el tope por hermano no aplica y se usa
  // el de una animación entera (mismo techo que IX_DELAY_MAX: nadie espera >3s a que algo empiece).
  const total = raw.total === true;
  const st: IxStagger = { each: clamp(each, 0, total ? IX_DELAY_MAX : IX_STAGGER_MAX) };
  if (from) st.from = from;
  if (total) st.total = true;
  const cols = num(raw.cols);
  if (cols !== undefined) {
    st.cols = Math.round(clamp(cols, IX_STAGGER_COLS_MIN, IX_STAGGER_COLS_MAX));
  }
  return st;
}

function normTrack(raw: unknown, warn: (w: string) => void): IxTrack | undefined {
  if (!isObj(raw)) return undefined;
  const target = normTarget(raw.target);
  if (!target) return undefined;
  const steps = normSteps(raw.steps, warn);
  if (!steps) return undefined;

  // Una pista que no toca NINGUNA propiedad no anima nada: se descarta antes de entrar en el
  // cuerpo. Si no, el emisor produciría `@keyframes n{0%{}100%{}}` y un `transition:` sin valor —
  // CSS inerte, pero ruido en la hoja y en el hash.
  //
  // Un color tomado del TEMA (C4) cuenta como propiedad tocada, exactamente igual que un número:
  // este guard y `unionProps` del compilador tienen que decir lo MISMO, o una pista que solo usa
  // tokens se caería aquí y el compilador no llegaría a verla nunca.
  const touches = (s: IxStep) =>
    IX_PROP_KEYS.some((k) => s.set[k] !== undefined) ||
    (s.tint !== undefined && IX_COLOR_PROP_KEYS.some((k) => s.tint![k] !== undefined));
  if (!steps.some(touches)) return undefined;

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

  // P6 — eje del puntero de la pista. "x" es el defecto y se borra (ausencia = defecto).
  const axis = oneOf(raw.axis, ["x", "y"] as const);
  if (axis === "y") track.axis = "y";

  const stagger = normStagger(raw.stagger);
  if (stagger) track.stagger = stagger;

  // P3 — opciones de pista, todas de lista cerrada o número clampado; "right"/"center"/1000 son
  // los valores iniciales y se BORRAN (ausencia = los bytes y el CSS de siempre).
  const clipDir = oneOf<IxClipDir>(raw.clipDir, IX_CLIP_DIRS);
  if (clipDir && clipDir !== "right") track.clipDir = clipDir;
  const origin = oneOf<IxOrigin>(raw.origin, IX_ORIGINS);
  if (origin && origin !== "center") track.origin = origin;
  const persp = num(raw.persp);
  if (persp !== undefined) {
    const v = Math.round(clamp(persp, IX_PERSP_MIN, IX_PERSP_MAX));
    if (v !== IX_PERSP_DEFAULT) track.persp = v;
  }

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
      // P10 — suavizado opt-in. 0 = exactitud nativa y se borra (ausencia = sin persecución).
      const smooth = num(raw.smooth);
      if (smooth !== undefined) {
        const v = Math.round(clamp(smooth, 0, IX_POINTER_SMOOTH_MAX));
        if (v > 0) t.smooth = v;
      }
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
    case "pointer": {
      const t: IxTrigger = { on: "pointer" };
      const area = oneOf(raw.area, ["self", "page"] as const);
      if (area === "page") t.area = "page";
      const smooth = num(raw.smooth);
      if (smooth !== undefined) {
        const v = Math.round(clamp(smooth, 0, IX_POINTER_SMOOTH_MAX));
        if (v !== IX_POINTER_SMOOTH_DEFAULT) t.smooth = v;
      }
      return t;
    }
    case "event": {
      // P11 — el nombre es un slug CERRADO o el disparador entero se descarta (fail-open).
      const name = raw.name;
      if (typeof name !== "string" || !IX_EVENT_NAME_RE.test(name)) return undefined;
      const t: IxTrigger = { on: "event", name };
      if (raw.toggle === true) t.toggle = true;
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

  // P7 — intensidad del bloque, clampada y a 2 decimales; 1 (el neutro) se borra: ausencia = 1.
  const amt = num(raw.amt);
  if (amt !== undefined) {
    const v = Math.round(clamp(amt, IX_AMT_MIN, IX_AMT_MAX) * 100) / 100;
    if (v !== 1) spec.amt = v;
  }

  // P4 — gating responsive: subconjunto de la lista cerrada, en orden canónico y sin duplicados.
  // Con los TRES apagados no hay interacción en ningún sitio: eso es «Quitar», no un gating — se
  // descarta el `off` entero avisando, y el bloque se mueve en todas partes (fail-open).
  if (Array.isArray(raw.off)) {
    const off = IX_BREAKPOINTS.filter((b) => (raw.off as unknown[]).includes(b));
    if (off.length === IX_BREAKPOINTS.length) {
      warn("desactivada en móvil, tablet y escritorio a la vez: eso es quitarla — se ignora el gating");
    } else if (off.length > 0) {
      spec.off = off;
    }
  }

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
