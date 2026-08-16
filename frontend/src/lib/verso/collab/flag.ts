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
 * Default del producto: ENCENDIDA.
 *
 * Nació apagada, y el motivo no era estar a medias: la revisión adversarial del TRANSPORTE dejó 18
 * hallazgos confirmados, cuatro críticos —identidad de réplica reclamable, epoch que no subía
 * nunca, listener de cierre registrado tras el `await join`, y `/resync` sin limitador—. Encender
 * un canal en vivo con eso pendiente habría sido servir el problema, no el producto.
 *
 * SE ENCIENDE AHORA porque las dos condiciones que se pusieron están cumplidas y comprobadas, no
 * argumentadas:
 *
 *  1. EL TRANSPORTE, tras seis rondas: los 18 originales y los que aparecieron después están
 *     cerrados, cada uno con un test que se pone ROJO al revertir su arreglo. Lo más grave que se
 *     corrigió, por si vuelve a aparecer la misma forma: una regla de expulsión que era FALSA en
 *     cuanto hay latencia (un frame ya en vuelo no se puede desconvocar), un guard que fallaba EN
 *     ABIERTO tratando un 200 sin cuerpo como confirmación, y una cola que había que acordarse de
 *     rellenar. El epoch de este despliegue, por ejemplo, ya va por 3: la detección de reinicio
 *     dejó de ser código muerto.
 *  2. MULTINODO REAL (Postgres + Redis + dos backends, laboratorio Proxmox): 60 ops emitidas = 60
 *     aceptadas = 60 filas en Postgres = 60 recibidas por el OTRO nodo, y 30/30/30/30 en sentido
 *     contrario; identidad de réplica no falsificable entre nodos (`forged-site`); epoch monótono
 *     propagándose a los editores de ambos. Ese gate destapó dos fallos del bus de clúster —con
 *     Redis caído la pérdida entre nodos era SILENCIOSA, y el bus no reconectaba jamás— que están
 *     arreglados en `core/cache.ts` y `core/collab-rooms.ts`.
 *  3. Y EN NAVEGADOR, con dos usuarios reales sobre el código actual: edición simultánea sobre el
 *     mismo párrafo contando letra a letra (61 caracteres, ni uno perdido ni duplicado, con los
 *     dos cursores en extremos opuestos), inserción y duplicación de bloques, deshacer, selección
 *     ajena con NOMBRE, reenganche tras recarga, y un corte de red que se anuncia y no pierde nada.
 *
 * LO QUE NO SE HA VERIFICADO EN NAVEGADOR, y conviene saberlo: dos editores contra DOS BACKENDS
 * distintos a través de la UI. La sustancia de ese escenario sí está probada (punto 2, contra el
 * router real), pero montar dos frontends —uno por backend— quedó fuera. Si aparece un problema de
 * colaboración sólo en despliegues multinodo, empieza por ahí.
 *
 * Para apagarla sin recompilar: `NEXT_PUBLIC_WORDJS_COLLAB=off` en el despliegue, o
 * `localStorage.wordjs_collab="off"` en un navegador concreto.
 */
export const COLLAB_DEFAULT_ON = true;

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
