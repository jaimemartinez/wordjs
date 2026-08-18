/**
 * Verso — interacciones: el HOST del runtime.
 *
 * El runtime no habla con `window` ni con `document` globales: recibe un host. Dos motivos, y el
 * segundo es el importante:
 *
 *  1. El canvas del editor es un IFRAME. Su `document` no es el del editor y su `defaultView` no es
 *     `window`. Un runtime que lea globales funciona en el sitio público y falla en el canvas — el
 *     mismo tipo de fallo que ya obligó a inyectar el `<link>` del tema a mano en el iframe.
 *  2. Se puede probar ENTERO en node, sin jsdom (que este proyecto no tiene instalado), con un
 *     host de mentira. Un runtime que solo se puede probar en un navegador es un runtime que no se
 *     prueba.
 *
 * Las interfaces `*Like` son un subconjunto ESTRUCTURAL de las del DOM: el `Document` real las
 * satisface. Se declaran aquí en vez de usar `lib.dom` para que el módulo no arrastre 15.000
 * líneas de tipos ni obligue a los tests a fabricar un `Element` completo.
 */
import type { IxKeyframe } from "../types";

export interface IxAnimationLike {
  /** `unknown` a propósito: el `currentTime` real es `CSSNumberish | null`, más ancho que number. */
  currentTime: unknown;
  pause(): void;
  cancel(): void;
  play(): void;
}

export interface IxAnimateOptions {
  duration: number;
  fill: "both";
  easing?: string;
  delay?: number;
  iterations?: number;
  direction?: string;
}

export interface IxElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
  querySelectorAll(selector: string): ArrayLike<IxElementLike>;
  /** `left`/`width` los usa SOLO el eje X del puntero (P6); el resto del motor vive de top/height. */
  getBoundingClientRect(): { top: number; height: number; left?: number; width?: number };
  readonly children: ArrayLike<IxElementLike>;
  /**
   * El ancestro más cercano que cumpla el selector, o `null`. Lo usa UNA cosa: anclar un `scrub`
   * con `src:"scene"` a la sección fija que lo contiene (C5). Es opcional porque el DOM real
   * siempre lo trae y ningún otro camino del runtime lo necesita: un host sin él degrada a medir
   * el propio bloque, que es lo que se medía antes de que existieran las escenas.
   */
  closest?(selector: string): IxElementLike | null;
  animate?(keyframes: IxKeyframe[], options: IxAnimateOptions): IxAnimationLike;
}

export interface IxDocumentLike {
  querySelectorAll(selector: string): ArrayLike<IxElementLike>;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
}

export interface IxObserverLike {
  observe(el: IxElementLike): void;
  unobserve(el: IxElementLike): void;
  disconnect(): void;
}

export type IxObserverEntry = { target: IxElementLike; isIntersecting: boolean };

/** Lo que el runtime necesita del entorno. Nada más: ninguna llamada a un global. */
export type IxHost = {
  doc: IxDocumentLike;
  /** Alto del viewport del documento — en el canvas es el del IFRAME, no el de la ventana. */
  viewportHeight(): number;
  /** Ancho del viewport — lo usa el eje X del puntero sobre `area: "page"` (P6). */
  viewportWidth(): number;
  /**
   * Progreso 0..1 del scroll del DOCUMENTO — lo que `animation-timeline: scroll()` mide de forma
   * nativa. El driver lo necesita para que `scrub` + `src:"page"` recorra lo MISMO en Firefox que
   * en Chrome: sin esto, el fallback solo sabía medir el recorrido del elemento por el viewport,
   * que es la definición de `view()`, no la de `scroll()`.
   */
  pageProgress(): number;
  /** `(prefers-reduced-motion: reduce)`. Si es cierto, el runtime NO arma nada. */
  reducedMotion(): boolean;
  /**
   * ¿Casa la condición `@media` del gating responsive (P4)? La condición la construyó el
   * compilador desde la lista cerrada de breakpoints. Se evalúa al ARMAR: cambiar el ancho de la
   * ventana con la página abierta no re-arma unidades (documentado — el CSS nativo sí responde en
   * vivo, el latch de JS no; recargar recompone ambos).
   */
  matchesMedia(cond: string): boolean;
  /** `CSS.supports("animation-timeline", fn)`. Decide si el chunk de scrub llega a bajar. */
  supportsTimeline(fn: string): boolean;
  /** Un ÚNICO IntersectionObserver por uso; `threshold: 0` fijo (ver el comentario en la isla). */
  observe(cb: (entries: IxObserverEntry[]) => void): IxObserverLike | null;
  raf(cb: () => void): number;
  caf(id: number): void;
  /** Carga PEREZOSA del driver de scrub. En producción es un `import()` → chunk aparte. */
  loadScrub(): Promise<IxScrubModule>;
};

export type IxScrubModule = {
  createScrubDriver: (
    units: readonly import("../types").IxRuntimeUnit[],
    host: IxHost,
  ) => () => void;
};

/**
 * Host real, atado a un documento concreto (el de la página, o el del iframe del canvas).
 *
 * Es el ÚNICO punto del motor que toca APIs del navegador, y el único con un cast: las interfaces
 * `*Like` son un subconjunto estructural de las del DOM, pero TypeScript no lo comprueba a través
 * de `NodeListOf`/`CSSNumberish` sin fricción, y no merece la pena retorcer los tipos del DOM para
 * un cast que está a la vista y comentado.
 */
export function defaultIxHost(doc: Document): IxHost {
  const view = doc.defaultView;
  return {
    doc: doc as unknown as IxDocumentLike,
    viewportHeight: () => view?.innerHeight ?? doc.documentElement?.clientHeight ?? 0,
    viewportWidth: () => view?.innerWidth ?? doc.documentElement?.clientWidth ?? 0,
    pageProgress: () => {
      const scroller = doc.scrollingElement ?? doc.documentElement;
      if (!scroller) return 0;
      const vh = view?.innerHeight ?? scroller.clientHeight;
      const max = scroller.scrollHeight - vh;
      if (max <= 0) return 0;
      const p = scroller.scrollTop / max;
      return p < 0 ? 0 : p > 1 ? 1 : p;
    },
    reducedMotion: () => !!view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    // Sin matchMedia (navegador arcaico) se asume que CASA: fail-open — la interacción corre.
    matchesMedia: (cond) => (view?.matchMedia ? view.matchMedia(cond).matches : true),
    supportsTimeline: (fn) => {
      try {
        return typeof CSS !== "undefined" && CSS.supports?.("animation-timeline", fn) === true;
      } catch {
        return false;
      }
    },
    observe: (cb) => {
      const IO = (view as unknown as { IntersectionObserver?: typeof IntersectionObserver })
        ?.IntersectionObserver;
      if (!IO) return null; // navegador antiquísimo → el bloque se queda visible y quieto
      // `threshold: 0` (primer píxel visible) y sin rootMargin negativo, por la misma razón
      // empírica que documenta entranceAnimation.ts: un umbral por ratio es geométricamente
      // inalcanzable para bloques más altos que el viewport, y un margen inferior negativo crea
      // una franja muerta al final de las páginas cortas. Ambos dejaban el bloque armado — es
      // decir, invisible — PARA SIEMPRE. No se "afinan".
      const io = new IO(
        (entries) =>
          cb(
            entries.map((e) => ({
              target: e.target as unknown as IxElementLike,
              isIntersecting: e.isIntersecting,
            })),
          ),
        { threshold: 0 },
      );
      return io as unknown as IxObserverLike;
    },
    raf: (cb) => view?.requestAnimationFrame?.(() => cb()) ?? 0,
    caf: (id) => view?.cancelAnimationFrame?.(id),
    loadScrub: () => import("./scrub"),
  };
}
