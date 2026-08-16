/**
 * GATE G-F8.1-c — round-trip BYTE-EXACTO a través del CRDT (spec §3.4, D12).
 *
 * `data → toNormalized → toCrdt → (0 ops) → fromCrdt → fromNormalized` tiene
 * que devolver el MISMO JSON, carácter a carácter, para todos los documentos
 * del corpus de producción. Es el gate que puede cancelar la fase: el canal
 * colaborativo no puede ensuciar el snapshot ni un byte.
 *
 * Y la variante CON RUIDO: K ops aplicadas en dos réplicas en órdenes
 * distintos ⇒ misma serialización en ambas.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fromNormalized, toNormalized } from "../../normalize";
import { CORPUS_PATH, loadVersoCorpus } from "../../__tests__/helpers";
import { CrdtDoc } from "../state";
import { generateOps, isRichText, isSlot, mulberry32, newReplica, sampleData, serialize, shuffle } from "./helpers";
import type { VersoData } from "../../types";

const roundTripThroughCrdt = (data: VersoData, rich = false): string => {
  const doc = toNormalized(data, isSlot);
  const state = CrdtDoc.fromDoc(doc, { site: "s_rt", isRichText: rich ? isRichText : undefined });
  return JSON.stringify(fromNormalized(state.toDoc()));
};

describe("CRDT round-trip — sintéticos", () => {
  it("documento plano", () => {
    const d = sampleData();
    expect(roundTripThroughCrdt(d)).toBe(JSON.stringify(d));
  });

  it("orden top-level original (root antes que content) y claves desconocidas", () => {
    const d = {
      root: { props: { title: "x" }, otra: 1 },
      content: [{ type: "Text", props: { id: "t", content: "<p>a</p>" } }],
      zones: {},
      _legacy: { keep: true },
    } as unknown as VersoData;
    expect(roundTripThroughCrdt(d)).toBe(JSON.stringify(d));
  });

  it("`content` ausente (revisiones reales) y `root` sin props", () => {
    const d = { root: {} } as unknown as VersoData;
    expect(roundTripThroughCrdt(d)).toBe(JSON.stringify(d));
  });

  it("zonas legacy huérfanas y slots vacíos se preservan verbatim", () => {
    const d = {
      content: [{ type: "Section", props: { id: "s", items: [] } }],
      root: { props: {} },
      zones: { "nope:zone": [{ type: "Text", props: { id: "z1" } }] },
    } as unknown as VersoData;
    expect(roundTripThroughCrdt(d)).toBe(JSON.stringify(d));
  });

  it("un campo de texto rico NO tocado se emite verbatim (jamás re-serializado)", () => {
    // HTML no canónico a propósito: si el CRDT lo reserializara, cambiaría.
    const d = {
      content: [{ type: "Text", props: { id: "t", content: "<p>a  <b>b</b></p>" } }],
      root: { props: {} },
    } as unknown as VersoData;
    expect(roundTripThroughCrdt(d, true)).toBe(JSON.stringify(d));
  });

  it("ids duplicados (dato corrupto real) sobreviven al round-trip", () => {
    const d = {
      content: [
        { type: "Text", props: { id: "dup", content: "a" } },
        { type: "Text", props: { id: "dup", content: "b" } },
      ],
      root: { props: {} },
    } as unknown as VersoData;
    expect(roundTripThroughCrdt(d)).toBe(JSON.stringify(d));
  });
});

const corpus = loadVersoCorpus();

describe.skipIf(!existsSync(CORPUS_PATH))("CRDT round-trip — corpus de producción", () => {
  it("el corpus está presente y tiene documentos", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it("cada documento del corpus vuelve BYTE-IGUAL a través del CRDT", () => {
    const fallos: string[] = [];
    for (const entry of corpus) {
      const before = JSON.stringify(fromNormalized(toNormalized(entry.versoData, isSlot)));
      const after = roundTripThroughCrdt(entry.versoData);
      if (before !== after) fallos.push(`#${entry.id} (${entry.type}/${entry.status})`);
    }
    expect(fallos).toEqual([]);
  });

  it("con los campos ricos ABIERTOS como CRDT de texto, sigue byte-igual", () => {
    const fallos: string[] = [];
    for (const entry of corpus) {
      const before = JSON.stringify(fromNormalized(toNormalized(entry.versoData, isSlot)));
      const after = roundTripThroughCrdt(entry.versoData, true);
      if (before !== after) fallos.push(`#${entry.id}`);
    }
    expect(fallos).toEqual([]);
  });

  it("con RUIDO: dos réplicas, mismas ops en órdenes distintos ⇒ misma serialización", () => {
    const rng = mulberry32(0xc0ffee);
    // Un corte del corpus: el gate completo tarda demasiado para un test unitario.
    const muestra = corpus.filter((_, i) => i % 7 === 0).slice(0, 12);
    for (const entry of muestra) {
      const a = newReplica(entry.versoData, "s_a");
      const ops = [];
      let seq = 0;
      for (let i = 0; i < 12; i++) {
        const batch = generateOps(a, { rng, nextId: () => `c${entry.id}x${(seq += 1)}` });
        for (const op of batch) a.apply(op);
        ops.push(...batch);
      }
      const b = newReplica(entry.versoData, "s_b");
      for (const op of shuffle(rng, ops)) b.apply(op);
      expect(serialize(b), `documento #${entry.id}`).toBe(serialize(a));
    }
  });
});
