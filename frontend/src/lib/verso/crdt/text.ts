/**
 * Verso CRDT — texto inline: CRDT de SECUENCIA por campo (D4, §1.4).
 *
 * La opción descartada (LWW por campo entero) pierde una de las dos ediciones
 * de un párrafo en silencio, y esa es la línea que este proyecto no cruza. Aquí
 * cada campo rico es una `FugueList<TextAtom>` sobre los MISMOS átomos que el
 * motor inline ya produce (`paraToAtoms`/`atomsToPara`): no se reescribe el
 * motor, se ENVUELVE. El serializador canónico sigue siendo la única autoridad
 * de forma.
 *
 * Marcas: por átomo, con LWW-HLC (§1.4.3). Se acepta y se documenta el
 * "agujero de negrita" (Peritext queda fuera de v1 — D5).
 *
 * DOS INVARIANTES QUE SOSTIENEN EL ROUND-TRIP BYTE-EXACTO (D12):
 *
 * 1. Mientras NO se aplique ninguna op de texto, el campo emite su cadena
 *    ORIGINAL verbatim (`raw`) — jamás una re-serialización. Reserializar
 *    canonizaría el HTML de páginas reales en el primer guardado colaborativo.
 * 2. Las posiciones semilla se derivan del snapshot (`~t:<nodeId>:<field>@i`),
 *    no del contador de ningún sitio: todas las réplicas que parten del mismo
 *    `_puck_data` obtienen las mismas posiciones sin hablar entre ellas.
 *
 * LÍMITE DECLARADO de v1: solo se abre como CRDT un campo cuyo HTML sea UN
 * párrafo (`parseRichHtml` → un bloque `p`). Listas y multi-bloque quedan como
 * prop LWW entera y las ops de texto sobre ellos se RECHAZAN con código tipado
 * (`text-field-not-open`) — degradación explícita, jamás pérdida silenciosa.
 */

import {
  atomsToPara,
  cloneMarks,
  NO_MARKS,
  paraToAtoms,
  parseRichHtml,
  serializeDoc,
  type Atom,
  type LinkAttrs,
  type Marks,
} from "../inline-engine";
import { FugueList } from "./fugue";
import { compareStamp, textSeedSite, type OpId, type PosRef, type Stamp } from "./identity";
import type { MarkName, WireAtom } from "./types";

interface TextAtom {
  br: boolean;
  ch: string;
}

interface MarkEntry {
  value: boolean | LinkAttrs | null;
  stamp: Stamp;
}

/** Copia defensiva de unas marcas de la red (nunca se confía en el objeto ajeno). */
export function sanitizeWireMarks(marks: unknown): Marks {
  const m = (marks ?? {}) as Partial<Marks>;
  const link = m.link;
  const okLink =
    typeof link === "object" && link !== null && typeof (link as LinkAttrs).href === "string"
      ? { href: (link as LinkAttrs).href, newTab: (link as LinkAttrs).newTab === true }
      : null;
  return { bold: m.bold === true, italic: m.italic === true, link: okLink };
}

export class TextField {
  private readonly list = new FugueList<TextAtom>();
  private readonly baseMarks = new Map<PosRef, Marks>();
  private readonly marks = new Map<string, MarkEntry>();
  private readonly raw: string;
  private dirty = false;
  private lastStamp: Stamp | null = null;

  private constructor(raw: string) {
    this.raw = raw;
  }

  /**
   * Abre un campo como CRDT de texto. `null` = el HTML no es un único párrafo
   * (límite declarado arriba): el llamador lo deja como prop LWW.
   */
  static open(nodeId: string, field: string, raw: unknown): TextField | null {
    if (typeof raw !== "string") return null;
    const parsed = parseRichHtml(raw);
    if (parsed.blocks.length !== 1 || parsed.blocks[0].kind !== "p") return null;
    const atoms = paraToAtoms(parsed.blocks[0].para);
    const out = new TextField(raw);
    const site = textSeedSite(nodeId, field);
    let left: PosRef | null = null;
    for (let i = 0; i < atoms.length; i++) {
      const id: OpId = { site, counter: i + 1 };
      const pos = `${site}@${i + 1}`;
      out.list.integrate(id, left, null, { br: atoms[i].br, ch: atoms[i].ch });
      out.baseMarks.set(pos, cloneMarks(atoms[i].marks));
      left = pos;
    }
    return out;
  }

  /** ¿Se ha aplicado alguna op de texto? (mientras no, se emite `raw` verbatim) */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** HLC de la última op de texto aplicada — arbitra contra un `propSet` rival. */
  get lastChange(): Stamp | null {
    return this.lastStamp;
  }

  get length(): number {
    return this.list.length;
  }

  livePositions(): readonly PosRef[] {
    return this.list.livePositions();
  }

  has(pos: PosRef): boolean {
    return this.list.has(pos);
  }

  neighborsForIndex(index: number): { left: PosRef | null; right: PosRef | null } {
    return this.list.neighborsForIndex(index);
  }

  insert(id: OpId, left: PosRef | null, right: PosRef | null, atom: WireAtom, stamp: Stamp): "ok" | "missing-origin" {
    const marks = sanitizeWireMarks(atom.marks);
    const value: TextAtom = { br: atom.br === true, ch: atom.br === true ? "" : String(atom.ch ?? "").slice(0, 1) };
    const res = this.list.integrate(id, left, right, value);
    if (!res.ok) return "missing-origin";
    if (res.created) {
      this.baseMarks.set(`${id.site}@${id.counter}`, marks);
      this.touch(stamp);
    }
    return "ok";
  }

  remove(pos: PosRef, stamp: Stamp): boolean {
    if (!this.list.has(pos)) return false;
    if (!this.list.isDeleted(pos)) {
      this.list.remove(pos);
      this.touch(stamp);
    }
    return true;
  }

  setMark(pos: PosRef, mark: MarkName, value: boolean | LinkAttrs | null, stamp: Stamp): boolean {
    if (!this.list.has(pos)) return false;
    const key = `${pos}|${mark}`;
    const cur = this.marks.get(key);
    if (cur && compareStamp(stamp, cur.stamp) <= 0) return true; // integrada y perdedora: no-op
    this.marks.set(key, { value, stamp });
    this.touch(stamp);
    return true;
  }

  /** Marcas efectivas de un átomo: las de origen con los LWW aplicados encima. */
  marksAt(pos: PosRef): Marks {
    const base = this.baseMarks.get(pos) ?? NO_MARKS;
    const bold = this.marks.get(`${pos}|bold`);
    const italic = this.marks.get(`${pos}|italic`);
    const link = this.marks.get(`${pos}|link`);
    return {
      bold: bold ? bold.value === true : base.bold,
      italic: italic ? italic.value === true : base.italic,
      link: link
        ? typeof link.value === "object" && link.value !== null
          ? { href: (link.value as LinkAttrs).href, newTab: (link.value as LinkAttrs).newTab === true }
          : null
        : base.link
          ? { ...base.link }
          : null,
    };
  }

  atoms(): Atom[] {
    return this.list.entries().map(({ pos, value }) => ({ br: value.br, ch: value.ch, marks: this.marksAt(pos) }));
  }

  /** Proyección canónica: `raw` intacto mientras nadie haya tocado el campo. */
  serialize(): string {
    if (!this.dirty) return this.raw;
    return serializeDoc({ blocks: [{ kind: "p", para: atomsToPara(this.atoms()) }] });
  }

  /** Volcado determinista para comparar réplicas en los tests. */
  debugDump(): string {
    return this.list
      .entries()
      .map(({ pos, value }) => {
        const m = this.marksAt(pos);
        const flags = `${m.bold ? "b" : ""}${m.italic ? "i" : ""}${m.link ? `a(${m.link.href},${m.link.newTab})` : ""}`;
        return `${pos}:${value.br ? "<br>" : value.ch}${flags}`;
      })
      .join("|");
  }

  private touch(stamp?: Stamp): void {
    this.dirty = true;
    if (stamp && (this.lastStamp === null || compareStamp(stamp, this.lastStamp) > 0)) this.lastStamp = stamp;
  }
}
