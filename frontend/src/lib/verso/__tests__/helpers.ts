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
  puckData: VersoData;
  hasZones?: boolean;
}

/** Entradas del corpus, o [] si el fichero no existe (misma semántica que el skipIf). */
export function loadVersoCorpus(): CorpusEntry[] {
  if (!existsSync(CORPUS_PATH)) return [];
  return (JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as { entries: CorpusEntry[] }).entries;
}
