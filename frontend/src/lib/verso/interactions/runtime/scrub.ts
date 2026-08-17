/**
 * Verso — interacciones: DRIVER DE SCRUB (chunk perezoso).
 *
 * Este fichero es el que Chrome y Safari 26+ NO descargan nunca. Solo baja cuando el navegador no
 * tiene `animation-timeline` (Firefox estable, agosto 2026: sigue tras el flag
 * `layout.css.scroll-driven-animations.enabled`, activo por defecto solo en Nightly) o cuando una
 * interacción apunta a OTRO bloque (que exigiría `timeline-scope`, no implementado en Firefox).
 *
 * SE DESCARTÓ el polyfill `flackr/scroll-timeline`: parchea el CSSOM globalmente, es grande, y
 * tendría que reparsear NUESTRA hoja generada para redescubrir lo que aquí ya se tiene como dato.
 * El driver recibe el IR directamente (los mismos `IxKeyframe[]` que el compilador emitió) y lo
 * aplica con WAAPI.
 *
 * LA TÉCNICA: la animación no CORRE, se POSICIONA. `el.animate(...)` + `pause()` + asignar
 * `currentTime` = progreso. Es exactamente lo mismo que hará el scrubber del panel (§6.3), y por
 * eso los dos salen del mismo IR y no pueden divergir.
 *
 * PRESUPUESTO: un IntersectionObserver y UN bucle `rAF` por documento, activo solo mientras haya
 * algo en pantalla. 30 unidades de las que 3 se ven cuestan 3, no 30.
 */
import type { IxEdge, IxRange, IxRuntimeUnit } from "../types";
import type { IxAnimationLike, IxElementLike, IxHost } from "./host";
import { ixStaggerOffset, resolveIxTargets } from "./targets";

/** Duración virtual de la animación pausada. 1000 y no 1: da 3 decimales de resolución al 0–100 %. */
const SCRUB_MS = 1000;

const toArray = <T>(list: ArrayLike<T>): T[] => Array.prototype.slice.call(list) as T[];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Igual que en el compilador: `scrub` y `view` sin `once` conducen el progreso con el scroll. */
const isTimeline = (u: IxRuntimeUnit): boolean =>
  u.trigger.on === "scrub" || (u.trigger.on === "view" && u.trigger.once === false);

/** `scrub` + `src:"page"`: el progreso es el del DOCUMENTO (`scroll()`), no el del elemento. */
const isPageTimeline = (u: IxRuntimeUnit): boolean =>
  u.trigger.on === "scrub" && u.trigger.src === "page";

/**
 * Suavizado del puntero por defecto (ms). Literal duplicado A PROPÓSITO respecto a
 * `IX_POINTER_SMOOTH_DEFAULT` (normalize.ts): importar el normalizador arrastraría el muestreo de
 * `linear()` a este chunk perezoso. Un test los mantiene iguales (mismo patrón que IX_REPLAY_EVENT).
 */
export const POINTER_SMOOTH_DEFAULT = 120;
/** dt fijo por frame (ms) para el factor de persecución: determinista y suficiente a 60 Hz. */
const POINTER_DT = 16.7;
/** Por debajo de esto el objetivo se considera alcanzado y el bucle puede dormirse. */
const POINTER_EPS = 0.001;

/**
 * Posición (en píxeles recorridos) de un borde de `animation-range`, siguiendo las definiciones de
 * la especificación de scroll-driven animations:
 *
 *   recorrido total = alto del viewport + alto del elemento
 *   recorrido actual = alto del viewport − `rect.top`
 *
 *   `cover`   : todo el recorrido, de que el borde superior toca el fondo del viewport a que el
 *               inferior toca la parte de arriba.
 *   `entry`   : del inicio a que el elemento está dentro del todo (o llena el viewport).
 *   `contain` : mientras está contenido (o cubriéndolo).
 *   `exit`    : de que empieza a salir hasta que sale del todo.
 */
function edgeTravel(edge: IxEdge, vh: number, h: number): number {
  const total = vh + h;
  const lo = Math.min(h, vh);
  const hi = Math.max(h, vh);
  let a = 0;
  let b = total;
  if (edge.at === "entry") {
    b = lo;
  } else if (edge.at === "contain") {
    a = lo;
    b = hi;
  } else if (edge.at === "exit") {
    a = hi;
  }
  return a + (b - a) * (edge.pct / 100);
}

function progressOf(anchor: IxElementLike, range: IxRange, vh: number): number {
  const rect = anchor.getBoundingClientRect();
  const h = rect.height;
  const from = edgeTravel(range.from, vh, h);
  const to = edgeTravel(range.to, vh, h);
  const span = to - from;
  if (span <= 0) return 0;
  return clamp01((vh - rect.top - from) / span);
}

/**
 * Progreso de una unidad de PÁGINA: el scroll del documento, ventaneado por los PORCENTAJES del
 * rango. Los nombres (`cover`/`entry`/…) se ignoran a propósito: son vocabulario de las timelines
 * de vista y el compilador tampoco los emite para `scroll()` — los dos backends miden lo mismo.
 */
function pageProgressOf(range: IxRange, pageP: number): number {
  const from = range.from.pct / 100;
  const to = range.to.pct / 100;
  const span = to - from;
  if (span <= 0) return 0;
  return clamp01((pageP - from) / span);
}

type ScrubEntry = { anchor: IxElementLike; range: IxRange; anim: IxAnimationLike; page: boolean };

/** Una animación POSICIONADA por el cursor (P6). `cur` persigue a `goal` con el suavizado. */
type PointerEntry = {
  anchor: IxElementLike;
  anim: IxAnimationLike;
  axis: "x" | "y";
  area: "self" | "page";
  smooth: number;
  cur: number;
  goal: number;
};

/** Scrub con suavizado (P10): el objetivo es el progreso de scroll y `cur` lo persigue. */
type ChasedEntry = {
  anchor: IxElementLike;
  anim: IxAnimationLike;
  range: IxRange;
  page: boolean;
  smooth: number;
  cur: number;
};

/**
 * Arranca el driver. Devuelve la limpieza: cancela TODAS las animaciones creadas, para el bucle y
 * desconecta el observer. Ninguna animación cancelada deja al elemento en un estado congelado —
 * `cancel()` devuelve el elemento a su estilo de hoja, que es el estado visible.
 */
export function createScrubDriver(units: readonly IxRuntimeUnit[], host: IxHost): () => void {
  const entries: ScrubEntry[] = [];
  const played: Array<{ el: IxElementLike; anim: IxAnimationLike }> = [];
  const byAnchor = new Map<IxElementLike, ScrubEntry[]>();

  const pointers: PointerEntry[] = [];
  const chased: ChasedEntry[] = [];

  for (const unit of units) {
    const roots = toArray(host.doc.querySelectorAll(`.${unit.cls}`));
    const timeline = isTimeline(unit);
    const page = isPageTimeline(unit);
    const pointer = unit.trigger.on === "pointer" ? unit.trigger : null;
    const chaseSmooth =
      unit.trigger.on === "scrub" && unit.trigger.smooth !== undefined ? unit.trigger.smooth : null;
    for (const root of roots) {
      for (const track of unit.tracks) {
        const targets = resolveIxTargets(root, track, host.doc);
        targets.forEach((el, i) => {
          if (typeof el.animate !== "function") return; // sin WAAPI → visible y quieto
          if (chaseSmooth !== null) {
            // P10: como el scrub llano, pero `cur` PERSIGUE el progreso en vez de igualarlo.
            const anim = el.animate(track.kf, { duration: SCRUB_MS, fill: "both", easing: "linear" });
            anim.pause();
            chased.push({ anchor: root, anim, range: track.range, page, smooth: chaseSmooth, cur: 0 });
            return;
          }
          if (pointer) {
            // P6: la animación no corre NI con el reloj NI con el scroll — la posiciona el cursor.
            // Reposo en el CENTRO de la pista (0.5): el paso 50 es el estado neutro por contrato.
            const anim = el.animate(track.kf, { duration: SCRUB_MS, fill: "both", easing: "linear" });
            anim.pause();
            anim.currentTime = 0.5 * SCRUB_MS;
            pointers.push({
              anchor: root,
              anim,
              axis: track.axis ?? "x",
              area: pointer.area ?? "self",
              smooth: pointer.smooth ?? POINTER_SMOOTH_DEFAULT,
              cur: 0.5,
              goal: 0.5,
            });
            return;
          }
          if (timeline) {
            // Escalonado ignorado en el camino de scroll, igual que en el CSS: el progreso ya lo
            // marca la posición del bloque, y desplazarlo por hermano no significaría nada.
            const anim = el.animate(track.kf, {
              duration: SCRUB_MS,
              fill: "both",
              easing: "linear",
            });
            anim.pause();
            const entry: ScrubEntry = { anchor: root, range: track.range, anim, page };
            entries.push(entry);
            const list = byAnchor.get(root);
            if (list) list.push(entry);
            else byAnchor.set(root, [entry]);
          } else {
            const anim = el.animate(track.kf, {
              duration: track.dur,
              fill: "both",
              easing: "linear",
              delay: track.delay + ixStaggerOffset(track, i, targets.length),
              iterations: track.repeat === "inf" ? Infinity : track.repeat,
              direction: track.alt ? "alternate" : "normal",
            });
            played.push({ el, anim });
          }
        });
      }
    }
  }

  const visible = new Set<IxElementLike>();
  let rafId: number | null = null;

  /* ── P6: estado del cursor, compartido por todas las entradas de puntero ── */
  let px = 0;
  let py = 0;
  let pointerSeen = false;

  /** ¿Alguna entrada de puntero sigue persiguiendo su objetivo? El bucle no duerme hasta llegar. */
  const updatePointers = (): boolean => {
    if (!pointerSeen) return false;
    let settling = false;
    const vw = host.viewportWidth();
    const vh = host.viewportHeight();
    for (const e of pointers) {
      if (!visible.has(e.anchor)) continue;
      if (e.area === "page") {
        e.goal = clamp01(e.axis === "x" ? (vw > 0 ? px / vw : 0.5) : (vh > 0 ? py / vh : 0.5));
      } else {
        const rect = e.anchor.getBoundingClientRect();
        e.goal =
          e.axis === "x"
            ? clamp01((rect.width ?? 0) > 0 ? (px - (rect.left ?? 0)) / (rect.width as number) : 0.5)
            : clamp01(rect.height > 0 ? (py - rect.top) / rect.height : 0.5);
      }
      // Persecución exponencial con dt fijo: determinista, y a 60 Hz indistinguible del reloj real.
      const k = e.smooth <= 0 ? 1 : 1 - Math.exp(-POINTER_DT / e.smooth);
      e.cur += (e.goal - e.cur) * k;
      if (Math.abs(e.goal - e.cur) <= POINTER_EPS) e.cur = e.goal;
      else settling = true;
      e.anim.currentTime = e.cur * SCRUB_MS;
    }
    return settling;
  };

  /** Persecución del scroll suavizado (P10). Devuelve si alguna entrada sigue en camino. */
  const updateChased = (vh: number): boolean => {
    let settling = false;
    let pageP: number | null = null;
    for (const e of chased) {
      if (!visible.has(e.anchor)) continue;
      let goal: number;
      if (e.page) {
        if (pageP === null) pageP = host.pageProgress();
        goal = pageProgressOf(e.range, pageP);
      } else {
        goal = progressOf(e.anchor, e.range, vh);
      }
      const k = e.smooth <= 0 ? 1 : 1 - Math.exp(-POINTER_DT / e.smooth);
      e.cur += (goal - e.cur) * k;
      if (Math.abs(goal - e.cur) <= POINTER_EPS) e.cur = goal;
      else settling = true;
      e.anim.currentTime = e.cur * SCRUB_MS;
    }
    return settling;
  };

  const update = (): boolean => {
    const vh = host.viewportHeight();
    // Se lee UNA vez por frame, no por unidad: todas las unidades de página miden el mismo scroll.
    let pageP: number | null = null;
    for (const anchor of visible) {
      const list = byAnchor.get(anchor);
      if (!list) continue;
      for (const e of list) {
        if (e.page) {
          if (pageP === null) pageP = host.pageProgress();
          e.anim.currentTime = pageProgressOf(e.range, pageP) * SCRUB_MS;
        } else {
          e.anim.currentTime = progressOf(anchor, e.range, vh) * SCRUB_MS;
        }
      }
    }
    const chasing = updateChased(vh);
    const pointing = updatePointers();
    return chasing || pointing;
  };

  // UN solo bucle por documento, y solo mientras haya algo en pantalla (o un puntero aún
  // persiguiendo su objetivo). No hacen falta listeners de `scroll`/`resize`: el bucle ya está
  // vivo exactamente durante la ventana en la que podrían aportar algo.
  const loop = () => {
    rafId = null;
    const settling = update();
    // Las entradas perseguidas (P10) mantienen el bucle vivo mientras haya algo visible: su
    // objetivo cambia con cada scroll y no hay listener de scroll — el bucle ES el muestreo.
    if (visible.size > 0 && (byAnchor.size > 0 || chased.length > 0 || settling || pointerSeen)) start();
  };
  const start = () => {
    if (rafId === null && visible.size > 0) rafId = host.raf(loop);
  };

  const onPointerMove = (ev: unknown) => {
    const e = ev as { clientX?: number; clientY?: number };
    if (typeof e.clientX !== "number" || typeof e.clientY !== "number") return;
    px = e.clientX;
    py = e.clientY;
    pointerSeen = true;
    start();
  };
  if (pointers.length > 0) host.doc.addEventListener("pointermove", onPointerMove);

  const io = host.observe((obs) => {
    for (const e of obs) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
    }
    if (visible.size > 0) {
      update();
      start();
    }
  });

  const anchors = new Set<IxElementLike>(byAnchor.keys());
  for (const p of pointers) anchors.add(p.anchor);
  for (const c of chased) anchors.add(c.anchor);
  if (io) for (const anchor of anchors) io.observe(anchor);
  else {
    // Sin IntersectionObserver: se posiciona una vez y se deja quieto. Visible siempre.
    for (const anchor of anchors) visible.add(anchor);
    update();
    visible.clear();
  }

  return () => {
    io?.disconnect();
    if (pointers.length > 0) host.doc.removeEventListener("pointermove", onPointerMove);
    if (rafId !== null) host.caf(rafId);
    rafId = null;
    visible.clear();
    for (const e of entries) e.anim.cancel();
    for (const p of played) p.anim.cancel();
    for (const p of pointers) p.anim.cancel();
    for (const c of chased) c.anim.cancel();
  };
}
