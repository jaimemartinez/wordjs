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
export function loadVersoCorpus(): CorpusEntry[] {
  if (!existsSync(CORPUS_PATH)) return [];
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
    entries: (CorpusEntry & { puckData?: VersoData })[];
  };
  return (raw.entries ?? []).map((e) => ({ ...e, versoData: e.versoData ?? e.puckData! }));
}
