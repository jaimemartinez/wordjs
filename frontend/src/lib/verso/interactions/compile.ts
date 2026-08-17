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
  IX_PROP_KEYS,
  IX_PROP_NEUTRAL,
  normalizeIxSpec,
} from "./normalize";
import type {
  IxBody,
  IxClipDir,
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
};

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
export const IX_DEFAULT_RANGES: Readonly<Record<"scrub" | "view", IxRange>> = Object.freeze({
  scrub: { from: { at: "cover", pct: 0 }, to: { at: "cover", pct: 100 } },
  view: { from: { at: "entry", pct: 0 }, to: { at: "cover", pct: 40 } },
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
    return { body, warnings };
  }

  if (!spec.tracks || spec.tracks.length === 0) return null;
  return {
    body: { trigger: spec.trigger ?? IX_DEFAULT_TRIGGER, tracks: spec.tracks },
    warnings,
  };
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
  for (const s of steps) for (const k of IX_PROP_KEYS) if (s.set[k] !== undefined) seen.add(k);
  return IX_PROP_KEYS.filter((k) => seen.has(k));
}

const valOf = (set: IxProps, k: IxPropKey): number => set[k] ?? IX_PROP_NEUTRAL[k];

/** Color 0xRRGGBB → `#rrggbb`. El emisor formatea; el autor jamás aporta la cadena. */
const hexColor = (v: number): string => `#${(Math.round(v) & 0xffffff).toString(16).padStart(6, "0")}`;

/**
 * Contexto de PISTA para emitir un estado: qué dirección recorta `clip`, con qué perspectiva se
 * emiten los 3D y qué `transform-origin` lleva la regla. Sale del normalizador, listas cerradas.
 */
type TrackCssCtx = { clipDir: IxClipDir; persp: number };

const trackCtx = (track: IxTrack): TrackCssCtx => ({
  clipDir: track.clipDir ?? "right",
  persp: track.persp ?? IX_PERSP_DEFAULT,
});

/**
 * Una sola declaración `transform` con TODO lo que la pista toca, en orden fijo:
 * perspective → translate3d → scale → scaleX/Y → rotate → rotateX/Y → skewX/Y.
 * `perspective()` va dentro del propio transform (no como propiedad `perspective` en el padre):
 * así la unidad es autocontenida y no depende de que algún ancestro coopere.
 */
function transformOf(set: IxProps, union: IxPropKey[], ctx: TrackCssCtx): string | undefined {
  const has = (k: IxPropKey) => union.includes(k);
  const parts: string[] = [];
  if (has("rotateX") || has("rotateY") || has("z")) parts.push(`perspective(${n(ctx.persp)}px)`);
  if (has("x") || has("y") || has("z")) {
    parts.push(
      `translate3d(${n(valOf(set, "x"))}px,${n(valOf(set, "y"))}px,${has("z") ? `${n(valOf(set, "z"))}px` : "0"})`,
    );
  }
  if (has("scale")) parts.push(`scale(${n(valOf(set, "scale"))})`);
  if (has("scaleX")) parts.push(`scaleX(${n(valOf(set, "scaleX"))})`);
  if (has("scaleY")) parts.push(`scaleY(${n(valOf(set, "scaleY"))})`);
  if (has("rotate")) parts.push(`rotate(${n(valOf(set, "rotate"))}deg)`);
  if (has("rotateX")) parts.push(`rotateX(${n(valOf(set, "rotateX"))}deg)`);
  if (has("rotateY")) parts.push(`rotateY(${n(valOf(set, "rotateY"))}deg)`);
  if (has("skewX")) parts.push(`skewX(${n(valOf(set, "skewX"))}deg)`);
  if (has("skewY")) parts.push(`skewY(${n(valOf(set, "skewY"))}deg)`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** La lista `filter` con lo que la pista toca, en orden canónico. blur va primero: era el único. */
function filterOf(set: IxProps, union: IxPropKey[]): string | undefined {
  const has = (k: IxPropKey) => union.includes(k);
  const parts: string[] = [];
  if (has("blur")) parts.push(`blur(${n(valOf(set, "blur"))}px)`);
  if (has("brightness")) parts.push(`brightness(${n(valOf(set, "brightness"))})`);
  if (has("contrast")) parts.push(`contrast(${n(valOf(set, "contrast"))})`);
  if (has("saturate")) parts.push(`saturate(${n(valOf(set, "saturate"))})`);
  if (has("grayscale")) parts.push(`grayscale(${n(valOf(set, "grayscale"))}%)`);
  if (has("hue")) parts.push(`hue-rotate(${n(valOf(set, "hue"))}deg)`);
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
function declsOf(set: IxProps, union: IxPropKey[], ctx: TrackCssCtx): string[] {
  const out: string[] = [];
  if (union.includes("opacity")) out.push(`opacity:${n(valOf(set, "opacity"))}`);
  const tf = transformOf(set, union, ctx);
  if (tf) out.push(`transform:${tf}`);
  const fl = filterOf(set, union);
  if (fl) out.push(`filter:${fl}`);
  if (union.includes("clip")) out.push(`clip-path:${clipCss(valOf(set, "clip"), ctx.clipDir)}`);
  if (set.textColor !== undefined) out.push(`color:${hexColor(set.textColor)}`);
  if (set.bgColor !== undefined) out.push(`background-color:${hexColor(set.bgColor)}`);
  if (set.borderColor !== undefined) out.push(`border-color:${hexColor(set.borderColor)}`);
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
  if (union.includes("textColor")) out.push("color");
  if (union.includes("bgColor")) out.push("background-color");
  if (union.includes("borderColor")) out.push("border-color");
  return out;
}

/** El mismo estado, en forma WAAPI (backend 2 del IR). */
function keyframeOf(step: IxStep, union: IxPropKey[], ctx: TrackCssCtx): IxKeyframe {
  const kf: IxKeyframe = { offset: round4(step.at / 100) };
  const ease = easeCss(step);
  if (ease) kf.easing = ease;
  if (union.includes("opacity")) kf.opacity = n(valOf(step.set, "opacity"));
  const tf = transformOf(step.set, union, ctx);
  if (tf) kf.transform = tf;
  const fl = filterOf(step.set, union);
  if (fl) kf.filter = fl;
  if (union.includes("clip")) kf.clipPath = clipCss(valOf(step.set, "clip"), ctx.clipDir);
  if (step.set.textColor !== undefined) kf.color = hexColor(step.set.textColor);
  if (step.set.bgColor !== undefined) kf.backgroundColor = hexColor(step.set.bgColor);
  if (step.set.borderColor !== undefined) kf.borderColor = hexColor(step.set.borderColor);
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
      return [`.${cls}[data-wjs-ix="on"]`];
    case "hover":
      // `:focus-visible` acompaña siempre a `:hover`: una interacción que solo existe para el ratón
      // es una interacción que no existe para quien navega con teclado.
      return [`.${cls}:hover`, `.${cls}:focus-visible`];
    case "scrub":
    case "load":
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
  parts.push("both");
  return `animation:${parts.join(" ")}`;
}

/* ------------------------------------------------------------------ */
/* Clasificación                                                       */
/* ------------------------------------------------------------------ */

const RUNTIME_RANK: Record<IxNeedsRuntime, number> = { never: 0, "no-native": 1, always: 2 };

const worseRuntime = (a: IxNeedsRuntime, b: IxNeedsRuntime): IxNeedsRuntime =>
  RUNTIME_RANK[a] >= RUNTIME_RANK[b] ? a : b;

/** ¿El disparador conduce el progreso con una timeline de scroll (y no con el tiempo)? */
const isTimeline = (t: IxTrigger): boolean =>
  t.on === "scrub" || (t.on === "view" && t.once === false);

function triggerRuntime(t: IxTrigger): IxNeedsRuntime {
  switch (t.on) {
    case "scrub":
      return "no-native";
    case "view":
      // once:false lo hace el CSS donde hay `animation-timeline`; once:true necesita un LATCH, y
      // en CSS no existe ninguno — este es el hallazgo que justifica conservar el
      // IntersectionObserver de `entranceAnimation.ts` tal cual.
      return t.once === false ? "no-native" : "always";
    case "click":
      return "always";
    case "hover":
    case "load":
      return "never";
  }
}

function rangeOf(t: IxTrigger): IxRange {
  if (t.on === "scrub") return t.range ?? DEFAULT_RANGE.scrub;
  if (t.on === "view") return t.range ?? DEFAULT_RANGE.view;
  return DEFAULT_RANGE.view;
}

const timelineFn = (t: IxTrigger): string =>
  t.on === "scrub" && t.src === "page" ? "scroll()" : "view()";

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

  body.tracks.forEach((track, i) => {
    const union = unionProps(track.steps);
    const tcx = trackCtx(track);
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
    if (suffix === null) {
      // Objetivo externo: sin CSS, resuelto por runtime. La unidad entera pasa a "always".
      needsRuntime = worseRuntime(needsRuntime, "always");
      warnings.push("objetivo externo (`block`): se resuelve por runtime, sin CSS (F9-A/B)");
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
      rules.push(
        rule(`.${cls}${suffix}`, [
          `transition:${props.map((p) => `${p} ${n(dur)}ms ${ease} ${n(delay)}ms`).join(",")}`,
          ...declsOf(a.set, union, tcx),
        ]),
      );
      rules.push(rule(sel, declsOf(b.set, union, tcx)));
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
      const fn = timelineFn(trigger);
      const isPage = fn === "scroll()";
      const pageRange = isPage ? pageRangeCss(rangeOf(trigger)) : null;
      const decls = [
        // Duración dummy de 1ms: el progreso lo conduce la timeline, no el reloj. El atajo va
        // PRIMERO porque resetea `animation-timeline`.
        `animation:${name} 1ms linear both`,
        `animation-timeline:${fn}`,
        ...(isPage
          ? pageRange
            ? [`animation-range:${pageRange}`]
            : []
          : [`animation-range:${rangeCss(rangeOf(trigger))}`]),
      ];
      rules.push(`@supports (animation-timeline:${fn}){${rule(sel, decls)}}`);
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
    const repeat = track.repeat ?? 1;
    const delayCss = wordsDelay(track, delay);
    // El easing POR PASO se emite dentro de los @keyframes; el de elemento se fija `linear` para
    // que no compita con él y el resultado sea el mismo en los dos backends.
    const isCalc = delayCss.startsWith("calc(");
    const decls = [
      // Un `calc()` dentro del atajo es válido pero frágil de leer y de parsear: cuando el retardo
      // es calculado (escalonado por palabras) se saca a su propia longhand.
      animShorthand(name, dur, isCalc ? "0ms" : delayCss, repeat, track.alt === true),
      ...(isCalc ? [`animation-delay:${delayCss}`] : []),
    ];
    rules.push(rule(sel, decls));

    // El estado ARMADO de una entrada `once`: el fotograma 0, congelado, bajo un atributo que solo
    // pone el JS. El HTML servido NUNCA lo lleva, así que ni los rastreadores ni un visitante sin
    // JS ven jamás contenido oculto (§7.1 — cero CLS, cero FOUC, nada que tapar).
    if (trigger.on === "view" && trigger.once !== false) {
      const armed = declsOf(track.steps[0].set, union, tcx);
      if (armed.length > 0) rules.push(rule(`.${cls}[data-wjs-ix="armed"]${suffix}`, armed));
    }

    rules.push(...staggerRules(cls, track, trigger, suffix, delay, "animation-delay", warnings));
  });

  return { hash, cls, body, rules, keyframes, kf, needsRuntime, warnings };
}

/**
 * Escalonado por palabras: el índice viaja como variable inline en cada `<span class="wjs-ixw">`
 * (lo estampa el renderer del split, el MISMO en canvas y público), así que una sola regla sirve
 * para las 40. `--wjs-ixv-i` lleva el prefijo del MOTOR (`--wjs-ixv-*`), no el de las clases
 * (`--wjs-ix-*`), y queda excluido del manifiesto de tokens de tema: no es una costura skinable.
 */
function wordsDelay(track: IxTrack, delay: number): string {
  if (track.target.kind === "words" && track.stagger && track.stagger.each > 0) {
    return `calc(var(${IX_WORD_INDEX_VAR}, 0) * ${n(track.stagger.each)}ms + ${n(delay)}ms)`;
  }
  return `${n(delay)}ms`;
}

/**
 * Reglas `:nth-child()` del escalonado sobre hijos DIRECTOS.
 *
 * `from: "end"` se emite con `:nth-last-child()`, que es EXACTO sin conocer el número de hijos.
 * `from: "center"` no es expresable en CSS puro (haría falta el recuento) → se avisa y se trata
 * como `start`: nunca se rompe el render por una capacidad que falta.
 * Del hermano IX_MAX_CHILDREN en adelante, todos comparten el retardo del 24.º — documentado, no
 * silencioso: es el tope de reglas generadas.
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
  if (from === "center") {
    warnings.push("escalonado desde el centro: no es expresable en CSS puro, se usa `start`");
    from = "start";
  }
  const nth = from === "end" ? "nth-last-child" : "nth-child";
  const bases = stateSelectors(cls, trigger);
  // El camino de hover con 2 pasos escalona el estado BASE (la transición vive en `.cls`),
  // no el estado `:hover`; el resto escalona el selector del disparador.
  const prefixes = prop === "transition-delay" ? [`.${cls}`] : bases;
  const out: string[] = [];

  for (let k = 1; k < IX_MAX_CHILDREN; k++) {
    const d = baseDelay + (k - 1) * st.each;
    out.push(rule(joinSel(prefixes, `>:${nth}(${k})`), [`${prop}:${n(d)}ms`]));
  }
  const last = baseDelay + (IX_MAX_CHILDREN - 1) * st.each;
  out.push(rule(joinSel(prefixes, `>:${nth}(n+${IX_MAX_CHILDREN})`), [`${prop}:${n(last)}ms`]));
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
      decls.push(...declsOf(s.set, union, ctx));
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
    blocks.push(...u.keyframes, ...u.rules);
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

function toRuntimeTrack(track: IxTrack, trigger: IxTrigger): IxRuntimeTrack {
  const union = unionProps(track.steps);
  const loadDelay = trigger.on === "load" ? (trigger.delay ?? 0) : 0;
  const out: IxRuntimeTrack = {
    kf: track.steps.map((s) => keyframeOf(s, union, trackCtx(track))),
    target: track.target,
    range: rangeOf(trigger),
    dur: track.dur ?? IX_DEFAULT_DUR,
    delay: (track.delay ?? IX_DEFAULT_DELAY) + loadDelay,
    repeat: track.repeat ?? 1,
    alt: track.alt === true,
  };
  if (track.stagger && track.stagger.each > 0) {
    out.stagger = { each: track.stagger.each, from: track.stagger.from ?? "start" };
  }
  return out;
}

export function toRuntimeUnit(unit: IxUnit): IxRuntimeUnit {
  return {
    cls: unit.cls,
    needsRuntime: unit.needsRuntime,
    trigger: unit.body.trigger,
    tracks: unit.body.tracks.map((t) => toRuntimeTrack(t, unit.body.trigger)),
  };
}

export type { IxSpec };
