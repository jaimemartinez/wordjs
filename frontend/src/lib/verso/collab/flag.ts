/**
 * Verso/colaboración — EL INTERRUPTOR (F8.4).
 *
 * La colaboración en vivo abre una conexión SSE por pestaña y difunde cada pulsación. Eso no puede
 * depender de adivinar: hay una bandera explícita, con un default declarado y dos formas de
 * apagarla sin recompilar nada.
 *
 * ORDEN DE PRECEDENCIA (de más fuerte a más débil):
 *
 *  1. `localStorage.wordjs_collab` — decisión de ESTE navegador. `"off"` la apaga, `"on"` la
 *     enciende aunque el despliegue la traiga apagada. Es el botón de pánico del autor: se pone
 *     desde la consola del navegador y sobrevive a la recarga.
 *         localStorage.setItem("wordjs_collab", "off"); location.reload();
 *  2. `NEXT_PUBLIC_WORDJS_COLLAB` — decisión del DESPLIEGUE (variable de entorno del build/arranque
 *     del frontend). `NEXT_PUBLIC_WORDJS_COLLAB=off` la apaga para todo el sitio.
 *  3. `COLLAB_DEFAULT_ON` — el default del producto.
 *
 * Apagada, el hook no abre NINGUNA conexión y el editor se comporta exactamente como antes de que
 * la colaboración existiera (contrato `INERT` de `useVersoCollab`).
 *
 * Por qué `NEXT_PUBLIC_*` literal y no una lectura dinámica: Next SUSTITUYE el literal en el bundle
 * del cliente en tiempo de build. Un `process.env[nombreCalculado]` no se sustituye y valdría
 * `undefined` siempre — la bandera parecería funcionar (default) y nunca haría caso al despliegue.
 */

/** Clave de localStorage del override por navegador. */
export const COLLAB_FLAG_STORAGE_KEY = "wordjs_collab";

/**
 * Default del producto: APAGADA.
 *
 * NO está apagada por estar a medias. El cableado del editor está completo y verificado en dos
 * navegadores a la vez (edición simultánea sobre el mismo párrafo, movimiento de bloques,
 * selección ajena, reenganche tras recarga, salida limpia). Está apagada porque la revisión
 * adversarial del TRANSPORTE (`backend/src/core/collab-rooms.ts`, `backend/src/routes/collab.ts`)
 * dejó 18 hallazgos confirmados, cuatro de ellos críticos, y encender un canal en vivo con eso
 * pendiente sería servir el problema, no el producto:
 *
 *  · el `siteId` es RECLAMABLE por otro editor autorizado — puede emitir ops a nombre de un
 *    tercero y, peor, las ops legítimas de la víctima se descartan EN SILENCIO por el UNIQUE;
 *  · el `epoch` no se incrementa nunca ⇒ toda la detección de reinicio de sala es código muerto;
 *  · el listener de cierre se registra DESPUÉS del `await join` ⇒ fuga de conexiones y de cupos;
 *  · `/resync` no pasa por el limitador de ritmo ⇒ amplificador de ~100 bytes a decenas de MB.
 *
 * SE ENCIENDE cuando esos hallazgos estén remediados y re-verificados, cambiando esta constante a
 * `true`. Hasta entonces, quien quiera probarla lo hace con el override por navegador (regla 1) o
 * con `NEXT_PUBLIC_WORDJS_COLLAB=on` en un entorno de pruebas.
 */
export const COLLAB_DEFAULT_ON = false;

/** Interpreta un valor de bandera. Lo que no es un sí/no reconocible NO opina (`undefined`). */
export function parseFlagValue(raw: string | null | undefined): boolean | undefined {
  if (raw === null || raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "on" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "off" || v === "false" || v === "no") return false;
  return undefined;
}

/** Resolución PURA de la bandera (la que se testea). */
export function resolveCollabEnabled(sources: {
  stored?: string | null;
  env?: string | null;
  defaultOn?: boolean;
}): boolean {
  const stored = parseFlagValue(sources.stored);
  if (stored !== undefined) return stored;
  const env = parseFlagValue(sources.env);
  if (env !== undefined) return env;
  return sources.defaultOn ?? COLLAB_DEFAULT_ON;
}

/**
 * La bandera efectiva en el navegador. En SSR devuelve el valor sin `localStorage` — y da igual,
 * porque el hook solo abre la conexión en un efecto, que no corre en el servidor.
 */
export function isCollabEnabled(): boolean {
  let stored: string | null = null;
  try {
    stored = typeof localStorage !== "undefined" ? localStorage.getItem(COLLAB_FLAG_STORAGE_KEY) : null;
  } catch {
    // Cookies/almacenamiento bloqueados: no es motivo para romper el editor.
  }
  return resolveCollabEnabled({ stored, env: process.env.NEXT_PUBLIC_WORDJS_COLLAB ?? null });
}
