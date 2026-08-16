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

type ScrubEntry = { anchor: IxElementLike; range: IxRange; anim: IxAnimationLike };

/**
 * Arranca el driver. Devuelve la limpieza: cancela TODAS las animaciones creadas, para el bucle y
 * desconecta el observer. Ninguna animación cancelada deja al elemento en un estado congelado —
 * `cancel()` devuelve el elemento a su estilo de hoja, que es el estado visible.
 */
export function createScrubDriver(units: readonly IxRuntimeUnit[], host: IxHost): () => void {
  const entries: ScrubEntry[] = [];
  const played: Array<{ el: IxElementLike; anim: IxAnimationLike }> = [];
  const byAnchor = new Map<IxElementLike, ScrubEntry[]>();

  for (const unit of units) {
    const roots = toArray(host.doc.querySelectorAll(`.${unit.cls}`));
    const timeline = isTimeline(unit);
    for (const root of roots) {
      for (const track of unit.tracks) {
        const targets = resolveIxTargets(root, track, host.doc);
        targets.forEach((el, i) => {
          if (typeof el.animate !== "function") return; // sin WAAPI → visible y quieto
          if (timeline) {
            // Escalonado ignorado en el camino de scroll, igual que en el CSS: el progreso ya lo
            // marca la posición del bloque, y desplazarlo por hermano no significaría nada.
            const anim = el.animate(track.kf, {
              duration: SCRUB_MS,
              fill: "both",
              easing: "linear",
            });
            anim.pause();
            const entry: ScrubEntry = { anchor: root, range: track.range, anim };
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

  const update = () => {
    const vh = host.viewportHeight();
    for (const anchor of visible) {
      const list = byAnchor.get(anchor);
      if (!list) continue;
      for (const e of list) {
        e.anim.currentTime = progressOf(anchor, e.range, vh) * SCRUB_MS;
      }
    }
  };

  // UN solo bucle por documento, y solo mientras haya algo en pantalla. No hacen falta listeners
  // de `scroll`/`resize`: el bucle ya está vivo exactamente durante la ventana en la que podrían
  // aportar algo, y coalescer un listener con rAF acabaría en el mismo sitio con más código.
  const loop = () => {
    rafId = null;
    update();
    if (visible.size > 0) start();
  };
  const start = () => {
    if (rafId === null && visible.size > 0) rafId = host.raf(loop);
  };

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

  if (io) for (const anchor of byAnchor.keys()) io.observe(anchor);
  else {
    // Sin IntersectionObserver: se posiciona una vez y se deja quieto. Visible siempre.
    for (const anchor of byAnchor.keys()) visible.add(anchor);
    update();
    visible.clear();
  }

  return () => {
    io?.disconnect();
    if (rafId !== null) host.caf(rafId);
    rafId = null;
    visible.clear();
    for (const e of entries) e.anim.cancel();
    for (const p of played) p.anim.cancel();
  };
}
