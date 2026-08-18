/**
 * Verso — interacciones: RECOLECTOR de las specs `ix` de un documento.
 *
 * `compileIxPage` necesita ver TODAS las interacciones de la página a la vez (deduplica por cuerpo,
 * resuelve colisiones de hash y decide qué baja al runtime). Esto es lo que se las da: un recorrido
 * del árbol de `_puck_data` que devuelve las specs CRUDAS, sin validar y sin ordenar — validar es
 * competencia del normalizador y ordenar lo hace el compilador por JSON canónico.
 *
 * El recorrido replica EXACTAMENTE el de `ContentRenderer.renderItem`: `data.content` y, dentro de
 * cada item, las props cuyo valor es un array de items (los slots — `children`, `col-0`…). Ni las
 * `zones` legacy ni ninguna otra forma: si el renderer no la pinta, no puede haber un bloque suyo
 * en la página, y compilar CSS para un bloque que no existe sería emitir bytes muertos.
 *
 * Los topes (profundidad y número de nodos) no son paranoia decorativa: `_puck_data` puede llegar
 * por la API o por una importación WXR, y un árbol de 100.000 nodos o con un ciclo convertiría el
 * render del servidor en una denegación de servicio. Al superarlos se DEJA DE RECORRER y se compila
 * lo recogido — la página se sirve entera; lo único que se pierde es movimiento. Fail-open.
 *
 * Puro, sin React ni DOM.
 */

/** Profundidad máxima de anidamiento (secciones dentro de columnas dentro de grids…). */
export const IX_COLLECT_MAX_DEPTH = 24;

/** Nodos máximos visitados por página. */
export const IX_COLLECT_MAX_NODES = 5000;

type Item = { type?: unknown; props?: unknown };

const isItem = (v: unknown): v is Item =>
  typeof v === "object" && v !== null && typeof (v as Item).type === "string";

/**
 * Todas las props `ix` del árbol, en orden de aparición. Se devuelven TAL CUAL (incluidos valores
 * absurdos): el compilador ya trata su entrada como hostil, y filtrar aquí duplicaría esa autoridad
 * en dos sitios que podrían discrepar.
 */
/**
 * Cuántos bloques del árbol llevan la ENTRADA CLÁSICA (`anim`), el sistema anterior al motor.
 *
 * El inventario del sitio (C5) la necesita para no mentir: casi todas las páginas ya publicadas se
 * mueven por aquí y no por `ix`, así que contar solo las interacciones diría que un sitio entero
 * está quieto. Se cuenta lo que MUEVE — una entrada con tipo o un efecto de scroll—, no la clave
 * vacía que todos los bloques llevan por defecto.
 */
export function collectAnimCount(data: unknown): number {
  let n = 0;
  const root = (data as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(root)) return 0;
  let visited = 0;
  const walk = (items: readonly unknown[], depth: number): void => {
    if (depth > IX_COLLECT_MAX_DEPTH) return;
    for (const item of items) {
      if (visited >= IX_COLLECT_MAX_NODES) return;
      if (!isItem(item)) continue;
      visited++;
      const props = item.props;
      if (typeof props !== "object" || props === null) continue;
      const bag = props as Record<string, unknown>;
      const anim = bag.anim as { type?: unknown; scroll?: unknown } | undefined;
      if (anim && typeof anim === "object" && (anim.type || anim.scroll)) n++;
      for (const value of Object.values(bag)) {
        if (Array.isArray(value) && value.some(isItem)) walk(value, depth + 1);
      }
    }
  };
  walk(root, 0);
  return n;
}

export function collectIxSpecs(data: unknown): unknown[] {
  const out: unknown[] = [];
  const root = (data as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(root)) return out;

  let visited = 0;

  const walk = (items: readonly unknown[], depth: number): void => {
    if (depth > IX_COLLECT_MAX_DEPTH) return;
    for (const item of items) {
      if (visited >= IX_COLLECT_MAX_NODES) return;
      if (!isItem(item)) continue;
      visited++;
      const props = item.props;
      if (typeof props !== "object" || props === null) continue;
      const bag = props as Record<string, unknown>;
      if (bag.ix !== undefined) out.push(bag.ix);
      for (const value of Object.values(bag)) {
        // Un slot es un array de items. Un array de strings (p.ej. las filas de una tabla) no lo
        // es, y `isItem` lo descarta hijo a hijo sin necesidad de conocer los nombres de slot de
        // cada bloque — que es justo lo que haría que este módulo se quedase atrás al añadir uno.
        if (Array.isArray(value) && value.some(isItem)) walk(value, depth + 1);
      }
    }
  };

  walk(root, 0);
  return out;
}
