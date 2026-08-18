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
import type { IxKeyframe, IxRuntimeTrack } from "../types";
import type { IxDocumentLike, IxElementLike } from "./host";

const toArray = <T>(list: ArrayLike<T>): T[] => Array.prototype.slice.call(list) as T[];

/** La clase del span de palabra. Literal a propósito: este módulo no importa el compilador. */
const WORD_SELECTOR = ".wjs-ixw";
/** El trazo SVG (P12), mismo criterio de literal. */
const SVG_SELECTOR = ".wjs-ixd";

/**
 * Los fotogramas que le tocan a ESTE elemento: el juego espejado si se lee de derecha a izquierda
 * y la pista tiene algo direccional, el normal en cualquier otro caso (C4).
 *
 * El camino CSS espeja con el token `--wjs-ix-dir`; aquí no se puede, porque un `var()` dentro de
 * un fotograma de `Element.animate()` no se resuelve y la animación se caería en silencio. Por eso
 * el compilador manda los dos juegos ya calculados y aquí solo se elige — misma aritmética, mismo
 * resultado, sin un segundo intérprete que un día discrepe.
 *
 * Se mira la dirección COMPUTADA del propio elemento, no la del documento: una página en español
 * puede llevar una cita en árabe con su `dir="rtl"`, y es esa la que manda sobre su movimiento.
 */
export function ixKeyframesFor(el: IxElementLike, track: IxRuntimeTrack): IxKeyframe[] {
  const view = (el as { ownerDocument?: { defaultView?: unknown } }).ownerDocument?.defaultView as
    | {
        getComputedStyle?: (e: unknown) => {
          direction?: string;
          getPropertyValue?: (p: string) => string;
        };
      }
    | undefined;
  const cs = view?.getComputedStyle?.(el);
  const kf = track.kfRtl && cs?.direction === "rtl" ? track.kfRtl : track.kf;
  return resolveVars(kf, cs);
}

/**
 * Sustituye los `var(--token)` de los fotogramas por su valor COMPUTADO en este elemento (C4).
 *
 * Hace falta porque `Element.animate()` no resuelve variables: un fotograma con `var(...)` se
 * descarta y la animación se cae EN SILENCIO — precisamente en el navegador que depende de este
 * camino. El CSS sí las resuelve solo, así que esto es lo que mantiene la paridad entre los dos
 * backends cuando un paso toma un color del tema.
 *
 * Solo toca los valores que son exactamente una variable (que es lo único que emite el compilador);
 * si el token no resuelve a nada, se deja el fotograma sin esa propiedad en vez de escribir basura:
 * el navegador interpolará desde el color natural del bloque, que es la degradación honesta.
 */
function resolveVars(kf: IxKeyframe[], cs?: { getPropertyValue?: (p: string) => string }): IxKeyframe[] {
  if (!cs?.getPropertyValue) return kf;
  let touched = false;
  const out = kf.map((frame) => {
    let copy: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(frame)) {
      if (typeof v !== "string") continue;
      const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
      if (!m) continue;
      if (!copy) copy = { ...frame };
      const resolved = cs.getPropertyValue!(m[1]).trim();
      if (resolved) copy[k] = resolved;
      else delete copy[k];
      touched = true;
    }
    return (copy ?? frame) as IxKeyframe;
  });
  return touched ? out : kf;
}

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
