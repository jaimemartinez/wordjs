/**
 * Verso/colaboración — QUÉ GENERACIÓN DE LA SALA está guardando este editor.
 *
 * El editor colaborativo guarda por la ruta de siempre (`PUT /posts/:id`), y el servidor tiene que
 * distinguir ese guardado —que ES el estado de la sala— de cualquier otra escritura del árbol de la
 * página (restaurar una revisión, otro editor sin colaboración, la API), que reinicia la sala para que
 * sus miembros recarguen lo escrito en vez de pisarlo con su copia. Lo que lo distingue es el `epoch`
 * del que se sembró el documento: viaja en `X-Collab-Epoch`, y un epoch que ya no es el vigente se
 * rechaza con 409 en lugar de deshacer el reinicio.
 *
 * Sin dependencias a propósito: `lib/api.ts` lo consulta en cada petición y no puede arrastrar el
 * cliente de colaboración entero (ni crear un ciclo de imports con él).
 */

const live = new Map<number, number>();

/** La sesión de `postId` está viva sobre `epoch` (o ya no lo está, con `null`). */
export function setCollabSaveEpoch(postId: number, epoch: number | null): void {
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (epoch !== null && Number.isInteger(epoch) && epoch > 0) live.set(id, epoch);
  else live.delete(id);
}

/** El epoch vivo de `postId`, o null si no hay sesión colaborativa abierta sobre él. */
export function collabSaveEpoch(postId: number): number | null {
  return live.get(Number(postId)) ?? null;
}

/** Cabeceras que `api()` añade a un guardado: solo un `PUT /posts/:id` con sesión viva sobre ese id. */
export function collabSaveHeaders(endpoint: string, method: string | undefined): Record<string, string> {
  if (String(method || "GET").toUpperCase() !== "PUT") return {};
  const m = /^\/posts\/(\d+)(?:[?#]|$)/.exec(String(endpoint || ""));
  if (!m) return {};
  const epoch = collabSaveEpoch(Number(m[1]));
  return epoch === null ? {} : { "X-Collab-Epoch": String(epoch) };
}
