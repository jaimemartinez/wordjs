/**
 * GATE F2 — round-trip del modelo de documento de Verso.
 *
 * Contrato: `fromNormalized(toNormalized(data))` debe reproducir `data` con
 * deep-equal EXACTO; la única diferencia permitida es la normalización
 * zones→slots ya vigente en el editor actual (una zona legacy cuyo nodo
 * destino existe se convierte en array de slot dentro de props). En todos
 * los casos el round-trip debe ser IDEMPOTENTE: una segunda pasada es un
 * punto fijo byte-a-byte.
 *
 * Corre en DOS corpus además de los sintéticos:
 *  · el de FORMAS (fixtures/corpus.shapes.json), commiteado y por tanto SIEMPRE ejercitado —
 *    estructura real anonimizada, derivada con scripts/verso-corpus-anonymize.mjs;
 *  · el REAL de producción (documentation/verso/corpus/corpus.json, gitignorado por contener
 *    contenido de clientes), cuando la máquina lo tiene exportado.
 * El primero existe porque el segundo falta en CI: sin él, este gate se saltaba entero y su verde
 * no distinguía "pasó" de "no se ejecutó".
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fromNormalized, toNormalized } from "../normalize";
import type { SlotResolver, VersoData } from "../types";
import { CORPUS_PATH, item, loadShapesCorpus, loadVersoCorpus, type CorpusEntry } from "./helpers";

const roundTrip = (d: VersoData, isSlot?: SlotResolver) => fromNormalized(toNormalized(d, isSlot));

describe("verso round-trip — sintéticos", () => {
  it("documento plano", () => {
    const d: VersoData = {
      content: [item("Heading", "h1", { title: "Hola", level: "h2" }), item("Text", "t1", { content: "<p>x</p>" })],
      root: { props: { title: "Página", _wjs_template: "" } },
    };
    expect(roundTrip(d)).toEqual(d);
  });

  it("slots anidados a profundidad 3, orden preservado", () => {
    const d: VersoData = {
      content: [
        {
          type: "Section",
          props: {
            id: "s1",
            items: [
              {
                type: "Grid",
                props: {
                  id: "g1",
                  items: [item("Card", "c1", { title: "A" }), item("Card", "c2", { title: "B" })],
                },
              },
            ],
          },
        },
      ],
      root: { props: {} },
    };
    const out = roundTrip(d);
    expect(out).toEqual(d);
    // El orden de hermanos es parte del contrato:
    const grid = (out.content[0].props.items as VersoData["content"])[0];
    expect((grid.props.items as VersoData["content"]).map((i) => i.props.id)).toEqual(["c1", "c2"]);
  });

  it("array vacío ambiguo: sin resolver queda como prop verbatim; con resolver=true queda como slot — ambos exactos", () => {
    const d: VersoData = { content: [item("Grid", "g1", { items: [] })], root: { props: {} } };
    expect(roundTrip(d)).toEqual(d);
    const asSlot: SlotResolver = (t, k) => (t === "Grid" && k === "items" ? true : undefined);
    expect(roundTrip(d, asSlot)).toEqual(d);
    expect(toNormalized(d, asSlot).nodes["g1"].slots.items).toEqual([]);
    expect(toNormalized(d).nodes["g1"].props.items).toEqual([]);
  });

  it("array con forma de item pero declarado NO-slot por el resolver: prop verbatim, sin indexar hijos", () => {
    const d: VersoData = {
      content: [item("Weird", "w1", { rows: [item("Fake", "f1")] })],
      root: { props: {} },
    };
    const notSlot: SlotResolver = () => false;
    const doc = toNormalized(d, notSlot);
    expect(doc.nodes["f1"]).toBeUndefined();
    expect(fromNormalized(doc)).toEqual(d);
  });

  it("zones legacy con destino vivo → slot en props (única diferencia permitida) + idempotente", () => {
    const d: VersoData = {
      content: [item("Columns", "col1")],
      root: { props: {} },
      zones: { "col1:col-0": [item("Text", "t1", { content: "x" })] },
    };
    const isSlot: SlotResolver = (t, k) => (t === "Columns" && k.startsWith("col-") ? true : undefined);
    const out1 = roundTrip(d, isSlot);
    // La zona migró a slot:
    expect(out1.content[0].props["col-0"]).toEqual([item("Text", "t1", { content: "x" })]);
    expect(out1.zones).toEqual({});
    // Idempotencia: segunda pasada = punto fijo exacto.
    expect(roundTrip(out1, isSlot)).toEqual(out1);
  });

  it("zona huérfana (nodo destino inexistente): preservada VERBATIM, jamás descartada", () => {
    const d: VersoData = {
      content: [item("Text", "t1")],
      root: { props: {} },
      zones: { "ghost:col-0": [item("Text", "t2", { content: "huérfano" })] },
    };
    const out = roundTrip(d);
    expect(out).toEqual(d);
    expect(toNormalized(d).warnings.some((w) => w.includes("huérfana"))).toBe(true);
  });

  it("zones:{} vacío conserva la clave; ausencia de zones no la inventa", () => {
    const conZones: VersoData = { content: [], root: { props: {} }, zones: {} };
    expect(roundTrip(conZones)).toEqual(conZones);
    const sinZones: VersoData = { content: [], root: { props: {} } };
    expect("zones" in roundTrip(sinZones)).toBe(false);
  });

  it("zones no-objeto (null / array): preservado verbatim sin throw", () => {
    const d = { content: [], root: { props: {} }, zones: null } as unknown as VersoData;
    expect(roundTrip(d)).toEqual(d);
  });

  it("claves desconocidas top-level y a nivel de item: verbatim", () => {
    const d = {
      content: [{ type: "Text", props: { id: "t1" }, readOnly: { content: true } }],
      root: { props: {} },
      futureKey: { anything: 1 },
    } as unknown as VersoData;
    expect(roundTrip(d)).toEqual(d);
  });

  it("ids duplicados (dato corrupto): ambos nodos sobreviven con su props.id original", () => {
    const d: VersoData = {
      content: [item("Text", "dup", { content: "a" }), item("Text", "dup", { content: "b" })],
      root: { props: {} },
    };
    const doc = toNormalized(d);
    expect(doc.warnings.some((w) => w.includes("duplicado"))).toBe(true);
    expect(fromNormalized(doc)).toEqual(d);
  });

  it('ids ["a","a#dup2","a"]: el sondeo de clave libre no pisa el "#dup2" literal — ningún item se pierde', () => {
    // Reproducción del bug: el contador por-id generaba "a#dup2" para la 2ª "a",
    // SOBRESCRIBIENDO el nodo cuyo props.id era literalmente "a#dup2".
    const d: VersoData = {
      content: [
        item("Text", "a", { content: "1" }),
        item("Text", "a#dup2", { content: "2" }),
        item("Text", "a", { content: "3" }),
      ],
      root: { props: {} },
    };
    const doc = toNormalized(d);
    expect(Object.keys(doc.nodes)).toHaveLength(3);
    expect(doc.warnings.some((w) => w.includes("duplicado"))).toBe(true);
    expect(fromNormalized(doc)).toEqual(d);
  });

  it("orden de claves EXACTO cuando id NO va primero (dato legacy real): content, id", () => {
    // Cazado en el gate F4: forzar id-primero reordenaba el JSON al primer guardado
    // (deep-equal pasaba; los diffs de revisiones se ensuciaban).
    const d: VersoData = {
      content: [{ type: "Text", props: { content: "<p>x</p>", id: "t1" } as never }],
      root: { props: {} },
    };
    expect(JSON.stringify(roundTrip(d))).toBe(JSON.stringify(d));
  });

  it("orden de claves EXACTO (byte-a-byte) con slot intercalado: id, items, title", () => {
    const d: VersoData = {
      content: [
        {
          type: "Box",
          props: { id: "b1", items: [item("Text", "t1", { content: "x" })], title: "T" },
        },
      ],
      root: { props: {} },
    };
    // deep-equal no distingue orden de claves; JSON.stringify sí — el slot debe
    // re-emitirse EN su posición original (entre id y title), no al final.
    expect(JSON.stringify(roundTrip(d))).toBe(JSON.stringify(d));
  });

  it("content ausente (revisiones reales 147/149/151 del corpus): la clave NO se inventa", () => {
    const d = { root: { props: { title: "solo root" } } } as unknown as VersoData;
    const out = roundTrip(d);
    expect(out).toEqual(d);
    expect("content" in out).toBe(false);
  });

  it("content presente pero no-array: verbatim; y si luego hay hijos reales, los hijos ganan", () => {
    const d = { content: "garbage", root: { props: {} } } as unknown as VersoData;
    expect(roundTrip(d)).toEqual(d);
    const doc = toNormalized(d);
    expect(doc.warnings.some((w) => w.includes("no-array"))).toBe(true);
  });

  it("root ausente: la clave no se inventa si no hay props que emitir", () => {
    const d = { content: [item("Text", "t1")] } as unknown as VersoData;
    expect(roundTrip(d)).toEqual(d);
  });

  it("root verbatim, incluidas claves fuera de props (title/slug legacy)", () => {
    const d = {
      content: [],
      root: { props: { title: "T" }, title: "legacy-title", slug: "legacy-slug" },
    } as unknown as VersoData;
    expect(roundTrip(d)).toEqual(d);
  });
});

// ---------------------------------------------------------------------------
// Corpus real de producción (opcional en CI: el fichero está gitignorado).
// La clasificación slot/prop aquí es estructural (sin registry) A PROPÓSITO:
// el round-trip debe ser exacto sea cual sea la clasificación.
// ---------------------------------------------------------------------------

const corpusAvailable = existsSync(CORPUS_PATH);

/**
 * El mismo contrato que el bloque de abajo, pero sobre el corpus de FORMAS commiteado — y SIN
 * skipIf, así que corre en CI y en cualquier máquina sin corpus exportado.
 *
 * POR QUÉ EXISTE: el corpus real está gitignorado (contenido de clientes), de modo que en CI el
 * suite de producción se saltaba ENTERO y su verde no significaba nada. La pérdida de datos en la
 * serialización es la clase de bug que más daño ha hecho en este árbol; su gate no puede depender
 * de un fichero que la mitad de las máquinas no tiene. El fixture conserva estructura, claves y su
 * orden (que es lo que el round-trip compara byte a byte) con el contenido anonimizado.
 */
describe("verso round-trip — corpus de formas (siempre)", () => {
  const shapes: CorpusEntry[] = loadShapesCorpus();

  it("el fixture commiteado existe y cubre formas reales", () => {
    expect(shapes.length).toBeGreaterThan(0);
  });

  it("cada documento hace round-trip BYTE A BYTE", () => {
    const failures: string[] = [];
    for (const entry of shapes) {
      const d = entry.versoData;
      try {
        expect(JSON.stringify(roundTrip(d))).toBe(JSON.stringify(d));
      } catch {
        failures.push(`doc ${entry.id} (${entry.type}/${entry.status})`);
      }
    }
    expect(failures, `round-trip falló en:\n${failures.join("\n")}`).toEqual([]);
  });
});

describe.skipIf(!corpusAvailable)("verso round-trip — corpus de producción", () => {
  const corpus: CorpusEntry[] = loadVersoCorpus();

  it("hay corpus que ejercitar", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it("cada documento sin zones hace round-trip EXACTO; con zones, idempotente con única diferencia zones→slots", () => {
    const failures: string[] = [];
    for (const entry of corpus) {
      const d = entry.versoData;
      let out1: VersoData;
      try {
        out1 = roundTrip(d);
      } catch (e) {
        failures.push(`doc ${entry.id}: throw en round-trip — ${String(e)}`);
        continue;
      }
      const hasRealZones = !!d.zones && Object.keys(d.zones).length > 0;
      try {
        if (hasRealZones) {
          expect(roundTrip(out1)).toEqual(out1); // punto fijo
        } else {
          // BYTE-a-byte (no solo deep-equal): el orden de claves también es contrato
          // — una reordenación ensucia los diffs de revisiones (cazado en F4).
          expect(JSON.stringify(out1)).toBe(JSON.stringify(d));
        }
      } catch {
        failures.push(`doc ${entry.id} (${entry.type}/${entry.status}, zones=${hasRealZones})`);
      }
    }
    expect(failures, `round-trip falló en:\n${failures.join("\n")}`).toEqual([]);
  });
});
