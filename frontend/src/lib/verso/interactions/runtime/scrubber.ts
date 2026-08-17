/**
 * Verso — interacciones: EL SCRUBBER DEL PANEL (§6.3 de la spec, F9-D).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * EL PROBLEMA QUE RESUELVE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * El botón «Probar» REPRODUCE la interacción entera. Para una entrada de 600 ms eso vale: se ve
 * pasar y ya está. Para una interacción ligada al scroll no vale para nada: su estado no depende del
 * reloj sino de DÓNDE está el bloque, así que para ajustar el paso intermedio hay que poder pararse
 * en el 37 % y mirar. Eso es esto.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ES FIEL, Y NO UNA IMITACIÓN
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * Se descartó de entrada lo obvio —escribir un `transform` interpolado a mano sobre el bloque—:
 * sería un SEGUNDO intérprete de los pasos, con su propio easing y su propia composición, y el día
 * que discrepase del compilador el autor estaría ajustando contra algo que el visitante no va a ver.
 *
 * Lo que se hace en su lugar es mover el ESTADO REAL:
 *
 *  1. los fotogramas son los MISMOS `IxKeyframe[]` que emitió el compilador (`unit.tracks[].kf`),
 *     el mismo backend WAAPI del IR que consume el driver de scrub de Firefox;
 *  2. la animación no CORRE, se POSICIONA: `el.animate(...)` → `pause()` → asignar `currentTime`.
 *     Es literalmente la técnica de `scrub.ts`, con el progreso viniendo del deslizador en vez de
 *     del `getBoundingClientRect`;
 *  3. una animación creada con `Element.animate()` está por encima de las animaciones CSS en la
 *     pila de efectos, así que mientras el scrubber vive, su fotograma GANA al `animation-timeline`
 *     nativo sin tocar ni un byte de la hoja; al `cancel()`, el CSS retoma el control solo.
 *
 * El módulo no toca el DOM más allá de crear y cancelar animaciones: no escribe estilos, no añade
 * clases, no mueve nodos. Si el scrubber muere a media sesión, el bloque vuelve a su CSS.
 *
 * Recibe elementos `*Like` (el subconjunto estructural de `host.ts`) para poder probarse ENTERO en
 * node sin jsdom, igual que el resto del runtime.
 */
import type { IxRuntimeUnit } from "../types";
import type { IxAnimationLike, IxDocumentLike, IxElementLike } from "./host";
import { ixKeyframesFor, ixStaggerOffset, resolveIxTargets } from "./targets";

/**
 * Duración virtual de una pista conducida por scroll. Mismo valor que el driver (`SCRUB_MS`): tres
 * decimales de resolución sobre el 0–100 %, que es más de lo que un deslizador de 1 % necesita.
 */
export const IX_SCRUB_MS = 1000;

/** ¿El progreso de esta unidad lo marca la POSICIÓN y no el reloj? (igual que en el compilador) */
const isTimeline = (u: IxRuntimeUnit): boolean =>
  u.trigger.on === "scrub" || (u.trigger.on === "view" && u.trigger.once === false);

export type IxScrubber = {
  /** Coloca la interacción en el `pct` (0–100) de su recorrido. Fuera de rango se clampa. */
  set(pct: number): void;
  /** Retira el scrubber: cancela todo y devuelve el bloque al CSS. Idempotente. */
  stop(): void;
  /** Cuántas animaciones se están posicionando. 0 ⇒ no había nada que recorrer. */
  readonly count: number;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Prepara el recorrido a mano de UNA unidad sobre UN elemento (su capa `.wjs-ix-<hash>`).
 *
 * Devuelve `null` cuando no hay nada que recorrer: ningún objetivo en el DOM (p. ej. una pista de
 * palabras en un bloque cuyo texto no se partió) o un navegador sin WAAPI. Nunca lanza — el peor
 * caso del previsualizador es no previsualizar, jamás romper el lienzo.
 *
 * EL EJE ES ÚNICO Y ABSOLUTO. Todas las animaciones de la unidad comparten un mismo 0 y un mismo
 * 100: `span` es el mayor `delay + duración` de todas, así que al 50 % una pista con retardo puede
 * no haber empezado todavía — que es exactamente lo que pasa en la reproducción real. Si cada
 * animación normalizase su propio 0–100, el escalonado desaparecería del previsualizador y el autor
 * ajustaría un retardo que no vería.
 */
export function createIxScrubber(
  root: IxElementLike,
  unit: IxRuntimeUnit,
  doc: IxDocumentLike,
): IxScrubber | null {
  const anims: IxAnimationLike[] = [];
  const timeline = isTimeline(unit);
  let span = 0;

  for (const track of unit.tracks) {
    const targets = resolveIxTargets(root, track, doc);
    targets.forEach((el, i) => {
      if (typeof el.animate !== "function") return; // sin WAAPI → el bloque se queda como está
      // En el camino de scroll el escalonado NO aplica (el progreso ya lo marca la posición del
      // bloque), exactamente igual que en el CSS que emite el compilador.
      const delay = timeline ? 0 : track.delay + ixStaggerOffset(track, i, targets.length);
      const duration = timeline ? IX_SCRUB_MS : track.dur;
      let anim: IxAnimationLike;
      try {
        anim = el.animate(ixKeyframesFor(el, track), {
          duration,
          fill: "both",
          // `linear` a nivel de elemento: la curva de cada tramo ya viaja DENTRO de los fotogramas
          // (`easing` por keyframe), igual que el compilador la emite dentro de los `@keyframes`.
          // Una curva aquí se multiplicaría con aquella y el recorrido dejaría de ser el mismo.
          easing: "linear",
          delay,
        });
      } catch {
        return; // fotogramas que este motor no acepta: se ignora esa pista, no se rompe nada
      }
      anim.pause();
      anims.push(anim);
      span = Math.max(span, delay + duration);
    });
  }

  if (anims.length === 0 || span <= 0) {
    for (const a of anims) a.cancel();
    return null;
  }

  let live = true;
  return {
    get count() {
      return anims.length;
    },
    set(pct: number) {
      if (!live) return;
      const p = Number.isFinite(pct) ? clamp01(pct / 100) : 0;
      const t = p * span;
      for (const a of anims) a.currentTime = t;
    },
    stop() {
      if (!live) return;
      live = false;
      // `cancel()` devuelve el elemento a su estilo de hoja, que es el estado VISIBLE: retirar el
      // scrubber nunca puede dejar un bloque congelado a medio camino.
      for (const a of anims) a.cancel();
      anims.length = 0;
    },
  };
}
