/**
 * EL PUENTE DE TEXTO COMO DIFERENCIA MÍNIMA (§3.2.3).
 *
 * La superficie inline solo sabe emitir `setProps` con el HTML ENTERO del campo.
 * Traducir eso como «borra todo lo vivo e inserta lo nuevo» converge, pero
 * converge en un párrafo DUPLICADO en cuanto teclean dos personas: cada borrado
 * solo alcanza a los átomos que su autor vio, así que las dos inserciones
 * enteras sobreviven.
 *
 * Estos tests fijan lo contrario: una pulsación es UNA op, y dos autores
 * tecleando en el mismo párrafo conservan las dos aportaciones sin duplicar
 * nada. Es el contrato del que depende el gate de navegador de F8.
 */

import { describe, expect, it } from "vitest";
import { commandToOps } from "../bridge";
import { bridgeOpts, feed, newReplica, sampleData, serialize } from "./helpers";
import type { CollabOp } from "../types";
import type { CrdtDoc } from "../state";

const emit = (state: CrdtDoc, command: Parameters<typeof commandToOps>[2]): CollabOp[] => {
  const res = commandToOps(state, state.toDoc(), command, bridgeOpts);
  if (!res.ok) throw new Error(`el puente rechazó el comando: ${res.error.code} ${res.error.message}`);
  return res.ops;
};

const nodeByPropId = (state: CrdtDoc, propId: string): string => {
  const doc = state.toDoc();
  const key = Object.keys(doc.nodes).find((k) => doc.nodes[k].props.id === propId);
  if (!key) throw new Error(`no existe un nodo con props.id "${propId}"`);
  return key;
};

const content = (state: CrdtDoc, node: string): string => String(state.toDoc().nodes[node].props.content);

/** Emite el `setProps` que produciría la superficie inline al teclear, y lo aplica en local. */
const type = (state: CrdtDoc, node: string, html: string): CollabOp[] => {
  const ops = emit(state, { kind: "setProps", nodeId: node, patch: { content: html } });
  feed(state, ops);
  return ops;
};

describe("Puente de texto — diferencia mínima", () => {
  it("una pulsación al final emite UNA op de inserción, no un reemplazo entero", () => {
    const A = newReplica(sampleData(), "s_a");
    const t1 = nodeByPropId(A, "t1"); // "<p>uno</p>"
    const ops = type(A, t1, "<p>unos</p>");
    expect(ops).toHaveLength(1);
    expect(ops[0].k).toBe("textInsert");
    expect(content(A, t1)).toBe("<p>unos</p>");
  });

  it("un borrado en medio emite UN textDelete y nada más", () => {
    const A = newReplica(sampleData(), "s_a");
    const t1 = nodeByPropId(A, "t1");
    const ops = type(A, t1, "<p>uo</p>");
    expect(ops).toHaveLength(1);
    expect(ops[0].k).toBe("textDelete");
    expect(content(A, t1)).toBe("<p>uo</p>");
  });

  it("un valor idéntico no emite NADA (ni entrada de historia ni tráfico)", () => {
    const A = newReplica(sampleData(), "s_a");
    const t1 = nodeByPropId(A, "t1");
    expect(emit(A, { kind: "setProps", nodeId: t1, patch: { content: "<p>uno</p>" } })).toHaveLength(0);
    // Y el campo sigue LIMPIO: emite su `raw` verbatim (invariante de round-trip byte-exacto).
    expect(content(A, t1)).toBe("<p>uno</p>");
  });

  it("cambiar SOLO las marcas de un átomo no reescribe el párrafo entero", () => {
    const A = newReplica(sampleData(), "s_a");
    const t1 = nodeByPropId(A, "t1");
    const ops = type(A, t1, "<p>u<strong>n</strong>o</p>");
    // Un átomo cambia de marcas ⇒ 1 borrado + 1 inserción; los otros dos ni se tocan.
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.k)).toEqual(["textDelete", "textInsert"]);
    expect(content(A, t1)).toBe("<p>u<strong>n</strong>o</p>");
  });

  it("EL CASO DEL GATE: dos autores tecleando a la vez en el MISMO párrafo", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const t1 = nodeByPropId(A, "t1");

    // Los dos parten de "uno": A escribe al final, B escribe al principio.
    const opsA = type(A, t1, "<p>unoA</p>");
    const opsB = type(B, t1, "<p>Buno</p>");
    feed(A, opsB);
    feed(B, opsA);

    expect(serialize(B)).toBe(serialize(A));
    // Ni se pierde ni se duplica: el texto base aparece UNA vez, con las dos aportaciones.
    expect(content(A, t1)).toBe("<p>BunoA</p>");
  });

  it("y sigue valiendo si cada uno teclea VARIOS caracteres antes de sincronizar", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const t1 = nodeByPropId(A, "t1");

    const opsA = [
      ...type(A, t1, "<p>unoa</p>"),
      ...type(A, t1, "<p>unoab</p>"),
      ...type(A, t1, "<p>unoabc</p>"),
    ];
    const opsB = [
      ...type(B, t1, "<p>xuno</p>"),
      ...type(B, t1, "<p>xyuno</p>"),
    ];
    feed(A, opsB);
    feed(B, opsA);

    expect(serialize(B)).toBe(serialize(A));
    expect(content(A, t1)).toBe("<p>xyunoabc</p>");
    // El párrafo base NO se duplicó (el defecto exacto del reemplazo entero).
    expect(content(A, t1).split("uno")).toHaveLength(2);
  });

  it("el orden de llegada no cambia el resultado (conmutatividad)", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const C = newReplica(data, "s_a2");
    const t1 = nodeByPropId(A, "t1");

    const opsA = type(A, t1, "<p>unoA</p>");
    const opsB = type(B, t1, "<p>Buno</p>");
    feed(A, opsB);
    feed(B, opsA);
    // C las recibe TODAS al revés y aterriza en el mismo sitio.
    feed(C, [...opsB].reverse(), [...opsA].reverse());
    feed(C, opsA, opsB); // reenvío: idempotente por dot

    expect(serialize(C)).toBe(serialize(A));
    expect(serialize(C)).toBe(serialize(B));
  });

  it("borrar TODO el párrafo sigue siendo un borrado de todos los átomos vivos", () => {
    const A = newReplica(sampleData(), "s_a");
    const t1 = nodeByPropId(A, "t1");
    const ops = type(A, t1, "<p></p>");
    expect(ops).toHaveLength(3);
    expect(ops.every((o) => o.k === "textDelete")).toBe(true);
    expect(content(A, t1)).toBe("");
  });

  it("un HTML multi-bloque conserva el camino de REEMPLAZO + propSet verbatim", () => {
    const A = newReplica(sampleData(), "s_a");
    const t1 = nodeByPropId(A, "t1");
    const ops = type(A, t1, "<p>uno</p><p>dos</p>");
    expect(ops.filter((o) => o.k === "textDelete")).toHaveLength(3);
    expect(ops[ops.length - 1].k).toBe("propSet");
    expect(content(A, t1)).toBe("<p>uno</p><p>dos</p>");
  });
});
