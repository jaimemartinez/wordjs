/**
 * Helpers compartidos por los tests del kernel Verso (roundtrip/commands/store).
 * Sin lógica de producción: solo fixtures y carga del corpus gitignorado.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VersoData, VersoItem } from "../types";

/** Fixture mínimo de bloque persistido. */
export const item = (type: string, id: string, extra: Record<string, unknown> = {}): VersoItem => ({
  type,
  props: { id, ...extra },
});

/** Corpus real de producción (gitignorado — los suites hacen skipIf cuando falta). */
export const CORPUS_PATH = resolve(__dirname, "../../../../../documentation/verso/corpus/corpus.json");

export interface CorpusEntry {
  id: number;
  type: string;
  status: string;
  versoData: VersoData;
  hasZones?: boolean;
}

/**
 * Entradas del corpus, o [] si el fichero no existe (misma semántica que el skipIf).
 *
 * El documento serializado se lee bajo `versoData` O bajo `puckData`, el nombre que emitía el
 * exportador antes del renombrado. El corpus está GITIGNORADO (es contenido real): cada quien tiene
 * el suyo exportado en su máquina, así que exigir el nombre nuevo dejaría esos ficheros ilegibles y
 * los suites de corpus reventarían con un `undefined` en vez de saltarse. Normalizamos aquí, en el
 * único punto de carga, para que el resto de los tests vea siempre `versoData`.
 */
/**
 * Corpus de FORMAS: derivado del real con scripts/verso-corpus-anonymize.mjs y COMMITEADO.
 *
 * Existe porque el corpus real está gitignorado (contenido de clientes), así que en CI el suite que
 * lo usa se saltaba entero — y un skip silencioso es indistinguible de un pase, justo en la garantía
 * que más daño ha hecho al romperse. Este fichero conserva lo único que el round-trip mide
 * (estructura, claves y su ORDEN, con la puntuación/markup/unicode intactos) y borra las palabras.
 */
export const SHAPES_CORPUS_PATH = resolve(__dirname, "fixtures/corpus.shapes.json");

export function loadShapesCorpus(): CorpusEntry[] {
  const raw = JSON.parse(readFileSync(SHAPES_CORPUS_PATH, "utf8")) as { entries: CorpusEntry[] };
  return raw.entries ?? [];
}

export function loadVersoCorpus(): CorpusEntry[] {
  if (!existsSync(CORPUS_PATH)) return [];
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
    entries: (CorpusEntry & { puckData?: VersoData })[];
  };
  return (raw.entries ?? []).map((e) => ({ ...e, versoData: e.versoData ?? e.puckData! }));
}
