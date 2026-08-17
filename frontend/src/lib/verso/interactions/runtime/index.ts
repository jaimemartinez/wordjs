/**
 * Verso — interacciones: LA ISLA DE EVENTOS (runtime mínimo).
 *
 * Qué hace, y NADA más: exactamente aquello que el CSS no puede expresar.
 *
 *  · `view` + `once: true` → el LATCH de "una sola vez". No existe en CSS: una `view()` timeline
 *    retrocede al subir. Es el hallazgo que justifica conservar el IntersectionObserver que ya hay.
 *  · `click` → tampoco hay latch. `:target` es un truco de URL y el checkbox-hack exige cambiar el
 *    markup, lo que rompería la regla de que canvas y público salgan del MISMO código.
 *  · `scrub` / `view` + `once: false` en un navegador SIN `animation-timeline` → carga perezosa del
 *    driver de scrub. En Chrome y Safari 26+ ese chunk NO se descarga nunca.
 *  · objetivo externo (`target: { kind: "block" }`) → exigiría `timeline-scope`, que Firefox no
 *    implementa; se delega al mismo chunk, que ya tiene el backend WAAPI.
 *
 * Lo que NO hace: tocar el DOM del bloque más allá de atributos `data-*`. No inyecta estilos, no
 * envuelve nodos, no lee ni escribe contenido. El markup lo pone el compilador; esto solo conmuta
 * un atributo.
 *
 * Sin dependencias (ni React, ni el compilador): recibe el manifiesto ya compilado y un host.
 */
import type { IxRuntimeUnit } from "../types";
import type { IxElementLike, IxHost, IxObserverLike } from "./host";

/**
 * Mismo evento DOM que `components/blocks/entranceAnimation.ts` (ANIM_REPLAY_EVENT), literal y no
 * importado: aquel módulo es `"use client"` y este tiene que poder cargarse como chunk suelto sin
 * arrastrar la frontera de cliente de React. La igualdad de las dos constantes está PINEADA en un
 * test — si alguien renombra una, el test cae.
 */
export const IX_REPLAY_EVENT = "wjs-anim-replay";

const STATE_ATTR = "data-wjs-ix";

const toArray = <T>(list: ArrayLike<T>): T[] => Array.prototype.slice.call(list) as T[];

/** ¿Alguna pista apunta a otro bloque? Eso obliga al backend WAAPI, haya o no soporte nativo. */
const hasExternalTarget = (u: IxRuntimeUnit): boolean =>
  u.tracks.some((t) => t.target.kind === "block");

/**
 * Arranca el motor sobre un documento. Devuelve la función de limpieza.
 *
 * Contrato de salida rápida: si la página no tiene NADA que el CSS no resuelva, esto retorna sin
 * crear un observer, sin registrar un listener y sin importar el chunk de scrub. Una página sin
 * interacciones no paga nada; una página con solo unidades nativas paga la comprobación de
 * `CSS.supports` y se va.
 */
export function startIxRuntime(units: readonly IxRuntimeUnit[], host: IxHost): () => void {
  const noop = () => {};
  if (units.length === 0) return noop;

  // Capa 3 de las tres del contrato de accesibilidad (las otras dos son el `@media` que envuelve
  // TODO el CSS generado y el bloque estático con `!important` en wordjs-ui.css). Sin override por
  // bloque ni por sitio: una preferencia del sistema operativo no es una casilla del panel.
  if (host.reducedMotion()) return noop;

  const latch: IxRuntimeUnit[] = [];
  const clicks: IxRuntimeUnit[] = [];
  const waapi: IxRuntimeUnit[] = [];

  for (const u of units) {
    // Gating responsive (P4): la MISMA condición @media que envuelve las reglas en la hoja. Se
    // evalúa al armar (ver el contrato en host.matchesMedia): en un dispositivo desactivado la
    // unidad ni observa, ni escucha, ni baja chunk.
    if (u.media && !host.matchesMedia(u.media)) continue;
    // P6: el puntero vive en el chunk WAAPI (posiciona animaciones, como el scrub) y solo baja
    // si la página lo usa.
    if (u.trigger.on === "pointer") {
      waapi.push(u);
      continue;
    }
    if (hasExternalTarget(u)) {
      waapi.push(u);
      continue;
    }
    if (u.needsRuntime === "no-native") {
      // El troceado es de BUNDLE, no solo de runtime: donde hay soporte nativo, el chunk no se
      // pide siquiera. Se comprueba la función concreta que la unidad usa.
      const fn = u.trigger.on === "scrub" && u.trigger.src === "page" ? "scroll()" : "view()";
      if (!host.supportsTimeline(fn)) waapi.push(u);
      continue;
    }
    if (u.trigger.on === "click") clicks.push(u);
    else if (u.trigger.on === "view") latch.push(u);
  }

  const cleanups: Array<() => void> = [];

  if (latch.length > 0) cleanups.push(startLatch(latch, host));
  if (clicks.length > 0) cleanups.push(startClicks(clicks, host));
  if (waapi.length > 0) {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void host
      .loadScrub()
      .then((mod) => {
        if (!cancelled) stop = mod.createScrubDriver(waapi, host);
      })
      .catch(() => {
        // El chunk no llegó: los bloques se quedan visibles y quietos. Fail-open.
      });
    cleanups.push(() => {
      cancelled = true;
      stop?.();
    });
  }

  return () => {
    for (const c of cleanups) c();
  };
}

/* ------------------------------------------------------------------ */
/* Latch de entrada (`view` + `once`)                                  */
/* ------------------------------------------------------------------ */

/**
 * UN solo IntersectionObserver para todas las unidades de entrada del documento.
 *
 * Secuencia: armar (`data-wjs-ix="armed"` → el CSS congela el fotograma 0) e inmediatamente
 * observar. El HTML servido no lleva el atributo, así que el contenido nunca sale oculto del
 * servidor; solo se oculta cuando hay JS que garantiza volver a mostrarlo.
 *
 * La limpieza NUNCA deja un bloque armado-invisible: si se desmonta a medio vuelo, se quita el
 * atributo. Es literalmente el fallo que costó encontrar en `entranceAnimation.ts` y no se va a
 * repetir aquí.
 */
function startLatch(units: readonly IxRuntimeUnit[], host: IxHost): () => void {
  const armed = new Set<IxElementLike>();
  let io: IxObserverLike | null = null;

  const els: IxElementLike[] = [];
  for (const u of units) for (const el of toArray(host.doc.querySelectorAll(`.${u.cls}`))) els.push(el);
  if (els.length === 0) return () => {};

  io = host.observe((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.setAttribute(STATE_ATTR, "in");
      armed.delete(e.target);
      io?.unobserve(e.target);
    }
  });

  if (!io) return () => {}; // sin IntersectionObserver → el bloque se queda visible, sin armar

  for (const el of els) {
    el.setAttribute(STATE_ATTR, "armed");
    armed.add(el);
    io.observe(el);
  }

  // Replay del editor: el mismo evento DOM que ya usa la entrada, porque cruza el iframe sin
  // puente de React. Se fuerza un reflow entre quitar y volver a poner el atributo para que el
  // navegador no coalesque las dos mutaciones en "no ha cambiado nada" (que se saltaría la
  // animación entera).
  const onReplay = () => {
    for (const el of els) {
      el.removeAttribute(STATE_ATTR);
      void (el as unknown as { offsetWidth?: number }).offsetWidth;
      el.setAttribute(STATE_ATTR, "in");
    }
  };
  host.doc.addEventListener(IX_REPLAY_EVENT, onReplay);

  return () => {
    io?.disconnect();
    host.doc.removeEventListener(IX_REPLAY_EVENT, onReplay);
    for (const el of armed) {
      if (el.getAttribute(STATE_ATTR) === "armed") el.removeAttribute(STATE_ATTR);
    }
    armed.clear();
  };
}

/* ------------------------------------------------------------------ */
/* Latch de clic                                                       */
/* ------------------------------------------------------------------ */

/**
 * Un listener por elemento con disparador de clic. `toggle` conmuta el atributo; sin `toggle` se
 * pone una vez y se queda (el "primer clic" de IX3).
 *
 * `keydown` con Enter/Espacio acompaña al clic: si una interacción solo responde al ratón, no
 * responde a media parte del público. No se toca el rol ni el tabindex del bloque — eso es markup,
 * y el markup lo pone el compilador, no esto.
 */
function startClicks(units: readonly IxRuntimeUnit[], host: IxHost): () => void {
  const bound: Array<{ el: IxElementLike; onClick: (ev: unknown) => void }> = [];

  for (const u of units) {
    const toggle = u.trigger.on === "click" && u.trigger.toggle === true;
    for (const el of toArray(host.doc.querySelectorAll(`.${u.cls}`))) {
      const onClick = (ev: unknown) => {
        const key = (ev as { key?: string } | undefined)?.key;
        const type = (ev as { type?: string } | undefined)?.type;
        if (type === "keydown" && key !== "Enter" && key !== " ") return;
        const on = el.getAttribute(STATE_ATTR) === "on";
        if (on && toggle) el.removeAttribute(STATE_ATTR);
        else el.setAttribute(STATE_ATTR, "on");
      };
      el.addEventListener("click", onClick);
      el.addEventListener("keydown", onClick);
      bound.push({ el, onClick });
    }
  }

  return () => {
    for (const { el, onClick } of bound) {
      el.removeEventListener("click", onClick);
      el.removeEventListener("keydown", onClick);
      el.removeAttribute(STATE_ATTR);
    }
  };
}
