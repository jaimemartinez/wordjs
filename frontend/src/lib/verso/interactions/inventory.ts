/**
 * DÓNDE SE MUEVE MI SITIO (C5) — el inventario del movimiento.
 *
 * Un CMS reparte las decisiones de movimiento entre muchas manos y muchas páginas: quien administra
 * el sitio acaba sin saber cuántos bucles perpetuos hay publicados, qué páginas bajan el motor de
 * JavaScript o dónde se usa un preajuste antes de tocarlo. Ninguno de los editores visuales del
 * mercado responde a esa pregunta; el precio de no responderla lo paga el visitante.
 *
 * Este módulo la responde con el MISMO compilador que sirve las páginas — no con una heurística
 * aparte que un día diría otra cosa: para cada contenido recoge sus specs (`collectIxSpecs`), las
 * compila (`compileIxPage`) y cuenta lo que la página realmente emitiría.
 *
 * Es puro y no toca el DOM ni la red: quien llama trae los contenidos ya leídos. Así se prueba en
 * node y así puede usarlo tanto la pantalla de administración como cualquier informe futuro.
 */
import { collectAnimCount, collectIxSpecs } from "./collect";
import { compileIxPage, type IxCompileCtx } from "./compile";

/** Un contenido a inventariar. `data` es el `_puck_data` YA parseado (o cualquier basura). */
export type IxInventoryEntry = {
  id: number;
  title: string;
  slug: string;
  type: string;
  data: unknown;
};

export type IxInventoryRow = {
  id: number;
  title: string;
  slug: string;
  type: string;
  /** Bloques con una interacción puesta (dos bloques iguales cuentan dos veces). */
  blocks: number;
  /** Interacciones DISTINTAS que la página emite (es lo que ocupa en la hoja). */
  units: number;
  /** Unidades con movimiento perpetuo — las que la norma obliga a poder parar. */
  infinite: number;
  /** Unidades que obligan a bajar el motor de JavaScript en ALGÚN navegador. */
  runtime: number;
  /** Preajustes del sitio usados en esta página, en orden alfabético. */
  presets: string[];
  /** Avisos del compilador para esta página (opciones ignoradas, topes…). */
  warnings: number;
  /** Bytes de CSS que esta página emite por su movimiento. */
  cssBytes: number;
  /**
   * Bloques con la ENTRADA CLÁSICA (`anim`), el sistema anterior al motor. Se cuenta aparte porque
   * es lo que llevan casi todas las páginas ya publicadas: sin esta columna, el inventario diría
   * que un sitio entero está quieto justo cuando no lo está.
   */
  entrances: number;
};

export type IxInventory = {
  rows: IxInventoryRow[];
  totals: {
    pages: number;
    /** Páginas CON movimiento (las demás no aparecen en la tabla). */
    moving: number;
    blocks: number;
    infinite: number;
    runtime: number;
    cssBytes: number;
    entrances: number;
  };
};

/** Los ids de preajuste que usa un árbol, sin repetir. Recorre las specs ya recogidas. */
function presetsOf(specs: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const s of specs) {
    const id = (s as { preset?: unknown } | null)?.preset;
    if (typeof id === "string" && id !== "") out.add(id);
  }
  return [...out].sort();
}

/**
 * El inventario, ordenado por CUÁNTO se mueve cada página (primero lo perpetuo, luego lo que baja
 * JavaScript, luego el volumen). Las páginas quietas no aparecen: la lista es para actuar sobre lo
 * que se mueve, no para pasear por todo el sitio.
 */
export function ixInventoryOf(
  entries: readonly IxInventoryEntry[],
  ctx?: IxCompileCtx,
): IxInventory {
  const rows: IxInventoryRow[] = [];
  const totals = {
    pages: entries.length,
    moving: 0,
    blocks: 0,
    infinite: 0,
    runtime: 0,
    cssBytes: 0,
    entrances: 0,
  };

  for (const entry of entries) {
    const specs = collectIxSpecs(entry.data);
    // La política del sitio manda también sobre la entrada clásica: con el movimiento apagado no
    // se mueve NADA, y el inventario tiene que decir lo mismo que la página.
    const entrances = ctx?.motion === "off" ? 0 : collectAnimCount(entry.data);
    const page = specs.length > 0 ? compileIxPage(specs, ctx) : null;
    if ((page === null || page.units.length === 0) && entrances === 0) continue;

    const infinite = (page?.units ?? []).filter((u) =>
      u.body.tracks.some((t) => t.repeat === "inf"),
    ).length;
    const row: IxInventoryRow = {
      id: entry.id,
      title: entry.title,
      slug: entry.slug,
      type: entry.type,
      blocks: specs.length,
      units: page?.units.length ?? 0,
      infinite,
      runtime: page?.runtime.length ?? 0,
      presets: presetsOf(specs),
      warnings: page?.warnings.length ?? 0,
      cssBytes: page?.css.length ?? 0,
      entrances,
    };
    rows.push(row);
    totals.moving += 1;
    totals.blocks += row.blocks;
    totals.infinite += row.infinite;
    totals.runtime += row.runtime;
    totals.cssBytes += row.cssBytes;
    totals.entrances += row.entrances;
  }

  rows.sort(
    (a, b) =>
      b.infinite - a.infinite ||
      b.runtime - a.runtime ||
      b.blocks + b.entrances - (a.blocks + a.entrances) ||
      a.title.localeCompare(b.title, "es") ||
      a.id - b.id,
  );
  return { rows, totals };
}
