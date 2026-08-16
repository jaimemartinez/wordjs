"use client";
/**
 * Verso — LA ISLA DEL RUNTIME DE INTERACCIONES en el sitio público (F9-C/E).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * QUÉ SE CARGA, Y CUÁNDO — el motivo entero de que este fichero sea así de pequeño
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 *   página SIN interacciones              → esto NO se renderiza: cero bytes. Ni un chunk.
 *   solo unidades nativas (`never`)        → tampoco: el servidor ya sabe que el CSS basta.
 *   alguna unidad `always` / `no-native`   → baja ESTA isla (unos cientos de bytes) y, dentro de un
 *                                            efecto, el runtime por `import()` dinámico.
 *   `no-native` + navegador sin soporte    → y solo entonces, el chunk `scrub` (lo pide el propio
 *                                            runtime vía `host.loadScrub`).
 *
 * El troceado es de BUNDLE, no de ejecución: quien decide es el SERVIDOR, que ya compiló la página
 * y sabe exactamente qué hace falta (`IxPage.runtime`, vacío cuando el CSS lo resuelve todo). Es la
 * diferencia con IX3, que carga GSAP + ScrollTrigger en toda página con interacciones.
 *
 * Un tema NUNCA envía JavaScript, y esto no lo cambia: el runtime es del NÚCLEO, viaja con el
 * contenido y solo aparece si el contenido lo pide. Ningún tema puede provocar su carga.
 *
 * NO renderiza markup (`null`). El estado inicial de una entrada `once` lo pone el navegador cuando
 * el runtime arma el bloque; el HTML servido nunca oculta nada, así que un visitante sin JS o un
 * rastreador ven la página entera. Fail-open: si el chunk no llega, los bloques se quedan visibles
 * y quietos.
 */
import { useEffect } from "react";
import type { IxRuntimeUnit } from "@/lib/verso/interactions";

export default function IxRuntimeIsland({ units }: { units: readonly IxRuntimeUnit[] }) {
  // La FIRMA, no el array: las props de un componente de servidor se reconstruyen en cada render
  // del árbol, y depender de la identidad del array re-arrancaría el runtime (re-armando los
  // bloques, es decir, parpadeando) sin que nada hubiera cambiado.
  const sig = JSON.stringify(units);

  useEffect(() => {
    const list = JSON.parse(sig) as IxRuntimeUnit[];
    if (list.length === 0) return;
    let stop: (() => void) | null = null;
    let cancelled = false;

    void Promise.all([
      import("@/lib/verso/interactions/runtime"),
      import("@/lib/verso/interactions/runtime/host"),
    ])
      .then(([runtime, host]) => {
        if (cancelled) return;
        stop = runtime.startIxRuntime(list, host.defaultIxHost(document));
      })
      .catch(() => {
        // El chunk no llegó (red, CSP, extensión): la página se queda como está — entera y visible.
      });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [sig]);

  return null;
}
