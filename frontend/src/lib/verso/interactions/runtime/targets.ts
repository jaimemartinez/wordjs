/**
 * Verso — interacciones: A QUÉ ELEMENTOS APUNTA UNA PISTA.
 *
 * Lo comparten los DOS consumidores del backend WAAPI del IR: el driver de scrub (el chunk que baja
 * en los navegadores sin `animation-timeline`) y el scrubber del panel. Vive aparte porque tenerlo
 * duplicado sería tener dos definiciones de "los hijos" o "las palabras" que un día divergen — y
 * entonces el previsualizador del editor enseñaría algo que el visitante no ve.
 *
 * Es la traducción exacta de `targetSuffix()` del compilador (compile.ts) al lado del DOM:
 * `self` → el propio elemento, `children` → sus hijos DIRECTOS (`>*`), `words` → sus spans de
 * palabra (` .wjs-ixw`), `block` → otro bloque por su `data-wjs-block-id`.
 */
import type { IxRuntimeTrack } from "../types";
import type { IxDocumentLike, IxElementLike } from "./host";

const toArray = <T>(list: ArrayLike<T>): T[] => Array.prototype.slice.call(list) as T[];

/** La clase del span de palabra. Literal a propósito: este módulo no importa el compilador. */
const WORD_SELECTOR = ".wjs-ixw";
/** El trazo SVG (P12), mismo criterio de literal. */
const SVG_SELECTOR = ".wjs-ixd";

export function resolveIxTargets(
  root: IxElementLike,
  track: IxRuntimeTrack,
  doc: IxDocumentLike,
): IxElementLike[] {
  switch (track.target.kind) {
    case "self":
      return [root];
    case "children":
      return toArray(root.children);
    case "words":
      return toArray(root.querySelectorAll(WORD_SELECTOR));
    case "svg":
      return toArray(root.querySelectorAll(SVG_SELECTOR));
    case "block":
      // El id está validado contra /^[A-Za-z0-9_-]{1,64}$/ en el normalizador: no puede romper el
      // selector ni traer nada que no sea alfanumérico.
      return toArray(doc.querySelectorAll(`[data-wjs-block-id="${track.target.id}"]`));
  }
}

/**
 * Desfase del escalonado de UN hermano (ms). Aquí sí se conoce el recuento de hermanos, así que
 * `center`, el tiempo TOTAL y la REJILLA son EXACTOS — como en el CSS con `sibling-index()`; el
 * fallback de `:nth-child` es el único que aproxima, y avisa.
 */
export function ixStaggerOffset(track: IxRuntimeTrack, index: number, count: number): number {
  const st = track.stagger;
  if (!st) return 0;
  if (st.cols !== undefined) {
    // Rejilla diagonal (fila + columna) — la MISMA fórmula que emite nativeStaggerExpr.
    return (Math.floor(index / st.cols) + (index % st.cols)) * st.each;
  }
  if (st.total === true) return index * (st.each / Math.max(1, count - 1));
  if (st.from === "end") return (count - 1 - index) * st.each;
  if (st.from === "center") return Math.abs(index - (count - 1) / 2) * st.each;
  return index * st.each;
}
