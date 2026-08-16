/**
 * INTENCIÓN — los casos que la spec DECLARA (§6 modelo de conflictos + D3/D10).
 *
 * Convergir no basta: converger en algo que el usuario no quiso es una pérdida
 * de datos con buenos modales. Cada test de aquí fija una intención concreta
 * que la spec promete y que el álgebra tiene que preservar.
 */

import { describe, expect, it } from "vitest";
import { ROOT_ID, ROOT_SLOT, type VersoData } from "../../types";
import { commandToOps } from "../bridge";
import { bridgeOpts, feed, item, newReplica, rootIds, sampleData, serialize, typeOps } from "./helpers";
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

/** Índices de una lista de ids: sirve para exigir CONTIGÜIDAD, no orden concreto. */
const contiguo = (todos: readonly string[], tirada: readonly string[]): boolean => {
  const idx = tirada.map((id) => todos.indexOf(id));
  if (idx.some((i) => i < 0)) return false;
  const orden = [...idx].sort((a, b) => a - b);
  return orden.every((v, i) => i === 0 || v === orden[i - 1] + 1);
};

describe("Intención — inserción concurrente en la misma posición", () => {
  it("BLOQUES: dos tiradas insertadas en el mismo índice NO se intercalan", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");

    const opsA: CollabOp[] = [];
    for (let i = 0; i < 3; i++) {
      const ops = emit(A, { kind: "insertNode", item: item("Text", `a${i}`), parentId: ROOT_ID, slotKey: ROOT_SLOT, index: i });
      feed(A, ops);
      opsA.push(...ops);
    }
    const opsB: CollabOp[] = [];
    for (let i = 0; i < 3; i++) {
      const ops = emit(B, { kind: "insertNode", item: item("Text", `b${i}`), parentId: ROOT_ID, slotKey: ROOT_SLOT, index: i });
      feed(B, ops);
      opsB.push(...ops);
    }

    feed(A, opsB);
    feed(B, opsA);
    expect(serialize(B)).toBe(serialize(A));

    const ids = rootIds(A);
    expect(contiguo(ids, ["a0", "a1", "a2"]), `orden final: ${ids.join(",")}`).toBe(true);
    expect(contiguo(ids, ["b0", "b1", "b2"]), `orden final: ${ids.join(",")}`).toBe(true);
    // Y nadie ha perdido nada.
    expect(ids).toHaveLength(9);
  });

  it("TEXTO: dos autores tecleando en el mismo offset no se intercalan letra a letra", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const t1 = nodeByPropId(A, "t1");

    const opsA = typeOps(A, t1, "content", 0, "hola");
    const opsB = typeOps(B, t1, "content", 0, "adios");
    feed(A, opsA);
    feed(B, opsB);
    feed(A, opsB);
    feed(B, opsA);

    expect(serialize(B)).toBe(serialize(A));
    const html = String(A.toDoc().nodes[t1].props.content);
    expect(html).toContain("hola");
    expect(html).toContain("adios");
    expect(html).toContain("uno");
    // El texto original sobrevive entero y las dos tiradas quedan enteras:
    expect(["<p>holaadiosuno</p>", "<p>adiosholauno</p>"]).toContain(html);
  });

  it("TEXTO: las dos ediciones sobreviven (la opción LWW por campo perdería una)", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const t1 = nodeByPropId(A, "t1");
    const opsA = typeOps(A, t1, "content", 3, " A!"); // al final de "uno"
    const opsB = typeOps(B, t1, "content", 0, "B: ");
    feed(A, opsA, opsB);
    feed(B, opsB, opsA);
    expect(serialize(B)).toBe(serialize(A));
    expect(String(A.toDoc().nodes[t1].props.content)).toBe("<p>B: uno A!</p>");
  });
});

describe("Intención — borrar vs editar", () => {
  it("el borrado GANA y converge, y la edición ajena no resucita el nodo", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const h1 = nodeByPropId(A, "h1");

    const del = emit(A, { kind: "removeNode", nodeId: h1 });
    const edit = emit(B, { kind: "setProps", nodeId: h1, patch: { title: "editado por B" } });

    feed(A, del, edit);
    feed(B, edit, del);
    expect(serialize(B)).toBe(serialize(A));
    expect(rootIds(A)).not.toContain("h1");
    expect(serialize(A)).not.toContain("editado por B");
  });

  it("«restaurar mi versión» = INSERCIÓN NUEVA: converge y no duplica el borrado", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const h1 = nodeByPropId(A, "h1");
    const del = emit(A, { kind: "removeNode", nodeId: h1 });
    feed(A, del);
    feed(B, del);
    // B re-inserta su contenido con id NUEVO (§6.2), no resucita el tombstone.
    const restore = emit(B, {
      kind: "insertNode",
      item: item("Heading", "h1-restaurado", { title: "Hola", level: "h2" }),
      parentId: ROOT_ID,
      slotKey: ROOT_SLOT,
      index: 0,
    });
    feed(B, restore);
    feed(A, restore);
    expect(serialize(A)).toBe(serialize(B));
    expect(rootIds(A)).toEqual(["h1-restaurado", "t1", "s1"]);
  });
});

describe("Intención — mover vs editar dentro (§6.3: NO es un conflicto)", () => {
  it("mover un bloque y editarlo concurrentemente conserva AMBAS intenciones", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const s1 = nodeByPropId(A, "s1");
    const t1 = nodeByPropId(A, "t1");

    const move = emit(A, { kind: "moveNode", nodeId: t1, toParentId: s1, toSlotKey: "items", toIndex: 0 });
    const edit = emit(B, { kind: "setProps", nodeId: t1, patch: { title: "editado" } });
    const texto = typeOps(B, t1, "content", 0, "X");

    feed(A, move, edit, texto);
    feed(B, edit, texto, move);
    expect(serialize(B)).toBe(serialize(A));

    const doc = A.toDoc();
    expect(doc.nodes[t1].parentId).toBe(s1);
    expect(doc.nodes[t1].props.title).toBe("editado");
    expect(String(doc.nodes[t1].props.content)).toBe("<p>Xuno</p>");
    expect(doc.rootChildren.map((id) => doc.nodes[id].props.id)).toEqual(["h1", "s1"]);
  });

  it("mover el ANCESTRO mientras se edita dentro tampoco pierde nada", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const s1 = nodeByPropId(A, "s1");
    const c1 = nodeByPropId(A, "c1");
    const move = emit(A, { kind: "moveNode", nodeId: s1, toParentId: ROOT_ID, toSlotKey: ROOT_SLOT, toIndex: 0 });
    const edit = emit(B, { kind: "setProps", nodeId: c1, patch: { title: "dentro" } });
    feed(A, move, edit);
    feed(B, edit, move);
    expect(serialize(B)).toBe(serialize(A));
    expect(rootIds(A)).toEqual(["s1", "h1", "t1"]);
    expect(A.toDoc().nodes[c1].props.title).toBe("dentro");
  });
});

describe("Intención — LWW por clave (D3)", () => {
  it("dos `setProps` de la MISMA clave: gana el HLC mayor", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a", { now: () => 1000 });
    const B = newReplica(data, "s_b", { now: () => 5000 });
    const h1 = nodeByPropId(A, "h1");
    const opsA = emit(A, { kind: "setProps", nodeId: h1, patch: { title: "de A" } });
    const opsB = emit(B, { kind: "setProps", nodeId: h1, patch: { title: "de B" } });
    feed(A, opsA, opsB);
    feed(B, opsB, opsA);
    expect(serialize(B)).toBe(serialize(A));
    expect(A.toDoc().nodes[h1].props.title).toBe("de B");
  });

  it("empate exacto de HLC: desempata el siteId, de forma ESTABLE", () => {
    const data = sampleData();
    const A = newReplica(data, "s_aaa", { now: () => 4242 });
    const B = newReplica(data, "s_bbb", { now: () => 4242 });
    const h1 = nodeByPropId(A, "h1");
    const opsA = emit(A, { kind: "setProps", nodeId: h1, patch: { title: "de A" } });
    const opsB = emit(B, { kind: "setProps", nodeId: h1, patch: { title: "de B" } });
    // Mismo (l,c): gana el siteId mayor, y gana igual en las dos réplicas.
    const solo = newReplica(data, "s_x");
    feed(solo, opsA, opsB);
    const otro = newReplica(data, "s_y");
    feed(otro, opsB, opsA);
    expect(serialize(otro)).toBe(serialize(solo));
    expect(solo.toDoc().nodes[h1].props.title).toBe("de B");
  });

  it("claves DISTINTAS del mismo bloque: sobreviven las dos (no se pisan)", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a");
    const B = newReplica(data, "s_b");
    const h1 = nodeByPropId(A, "h1");
    const opsA = emit(A, { kind: "setProps", nodeId: h1, patch: { title: "T" } });
    const opsB = emit(B, { kind: "setProps", nodeId: h1, patch: { level: "h4" } });
    feed(A, opsA, opsB);
    feed(B, opsB, opsA);
    expect(serialize(B)).toBe(serialize(A));
    expect(A.toDoc().nodes[h1].props).toMatchObject({ title: "T", level: "h4" });
  });

  it("borrar una clave es un TOMBSTONE con HLC: gana o pierde según el reloj", () => {
    const data = sampleData();
    const viejo = newReplica(data, "s_a", { now: () => 1000 });
    const nuevo = newReplica(data, "s_b", { now: () => 9000 });
    const h1 = nodeByPropId(viejo, "h1");
    const borrar = emit(viejo, { kind: "setProps", nodeId: h1, patch: { title: undefined } });
    const escribir = emit(nuevo, { kind: "setProps", nodeId: h1, patch: { title: "posterior" } });
    const r1 = newReplica(data, "s_x");
    feed(r1, borrar, escribir);
    const r2 = newReplica(data, "s_y");
    feed(r2, escribir, borrar);
    expect(serialize(r2)).toBe(serialize(r1));
    expect(r1.toDoc().nodes[h1].props.title).toBe("posterior");
  });
});

describe("Intención — moves concurrentes (D10 / G-F8.1-d)", () => {
  it("dos moves del MISMO nodo: gana el HLC mayor y NO se duplica", () => {
    const data = sampleData();
    const A = newReplica(data, "s_a", { now: () => 1000 });
    const B = newReplica(data, "s_b", { now: () => 8000 });
    const t1 = nodeByPropId(A, "t1");
    const s1 = nodeByPropId(A, "s1");
    const moveA = emit(A, { kind: "moveNode", nodeId: t1, toParentId: ROOT_ID, toSlotKey: ROOT_SLOT, toIndex: 0 });
    const moveB = emit(B, { kind: "moveNode", nodeId: t1, toParentId: s1, toSlotKey: "items", toIndex: 1 });
    feed(A, moveA, moveB);
    feed(B, moveB, moveA);
    expect(serialize(B)).toBe(serialize(A));
    const doc = A.toDoc();
    expect(doc.nodes[t1].parentId).toBe(s1);
    // Aparece UNA sola vez en todo el documento (el bug clásico de remove+insert).
    const apariciones = serialize(A).split('"t1"').length - 1;
    expect(apariciones).toBe(1);
    expect(rootIds(A)).toEqual(["h1", "s1"]);
  });

  it("moves que formarían CICLO: mismo resultado en todas, sin ciclo y sin duplicado", () => {
    const data: VersoData = {
      content: [
        { type: "Section", props: { id: "X", items: [] } },
        { type: "Section", props: { id: "Y", items: [] } },
      ],
      root: { props: {} },
    };
    const A = newReplica(data, "s_a", { now: () => 1000 });
    const B = newReplica(data, "s_b", { now: () => 2000 });
    const X = nodeByPropId(A, "X");
    const Y = nodeByPropId(A, "Y");
    // A mueve X dentro de Y; B (concurrente) mueve Y dentro de X.
    const moveA = emit(A, { kind: "moveNode", nodeId: X, toParentId: Y, toSlotKey: "items", toIndex: 0 });
    const moveB = emit(B, { kind: "moveNode", nodeId: Y, toParentId: X, toSlotKey: "items", toIndex: 0 });

    const r1 = newReplica(data, "s_1");
    feed(r1, moveA, moveB);
    const r2 = newReplica(data, "s_2");
    feed(r2, moveB, moveA);
    expect(serialize(r2)).toBe(serialize(r1));

    const doc = r1.toDoc();
    // Ni ciclo (los dos siguen siendo alcanzables desde la raíz) ni duplicados.
    const total = serialize(r1);
    expect(total.split('"X"').length - 1).toBe(1);
    expect(total.split('"Y"').length - 1).toBe(1);
    // Resultado del log de moves de Kleppmann: se replayan en orden de HLC y se
    // descarta el que crea ciclo EN ESE ESTADO. moveA (HLC menor) se aplica —
    // X dentro de Y — y moveB pasa a ser el que cerraría el ciclo ⇒ descartado.
    // Lo que importa no es cuál gana, sino que TODAS las réplicas descarten el
    // mismo, sea cual sea el orden de entrega (eso es lo que no converge si se
    // descarta "el que llega y crea ciclo").
    expect(doc.nodes[X].parentId).toBe(Y);
    expect(doc.rootChildren.map((id) => doc.nodes[id].props.id)).toEqual(["Y"]);
  });
});
