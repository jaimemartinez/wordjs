/**
 * INTEGRIDAD CON EL CONTRATO EXISTENTE — el puente comando ↔ operación.
 *
 * Propiedad que se exige aquí: para el MISMO comando efectivo, el camino local
 * (`applyCommand` sobre el `VersoDoc`) y el camino replicado (traducir a ops e
 * integrarlas en el CRDT) producen el MISMO `_puck_data`, byte a byte. Si esto
 * no se cumple, la colaboración cambia el documento por el mero hecho de estar
 * conectada — que es exactamente lo que D12 prohíbe.
 */

import { describe, expect, it } from "vitest";
import { applyCommand } from "../../commands";
import { fromNormalized, toNormalized } from "../../normalize";
import { ROOT_ID, ROOT_SLOT, type VersoCommand, type VersoDoc, type VersoItem } from "../../types";
import { commandToOps } from "../bridge";
import { bridgeOpts, isSlot, item, mulberry32, newReplica, pick, pickInt, sampleData, serialize } from "./helpers";

/** props.id → clave interna del doc (los dos docs indexan distinto a propósito). */
function indexByPropId(doc: VersoDoc): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, node] of Object.entries(doc.nodes)) {
    const pid = String(node.props.id);
    if (!out.has(pid)) out.set(pid, key);
  }
  return out;
}

/** Traduce las referencias de nodo de un comando entre dos indexados distintos. */
function translate(cmd: VersoCommand, from: VersoDoc, to: VersoDoc): VersoCommand | null {
  const fromDoc = from;
  const idx = indexByPropId(to);
  const map = (id: string): string | null => {
    if (id === ROOT_ID) return ROOT_ID;
    const node = Object.hasOwn(fromDoc.nodes, id) ? fromDoc.nodes[id] : undefined;
    if (!node) return null;
    return idx.get(String(node.props.id)) ?? null;
  };
  switch (cmd.kind) {
    case "insertNode": {
      const parentId = map(cmd.parentId);
      return parentId === null ? null : { ...cmd, parentId };
    }
    case "removeNode": {
      const nodeId = map(cmd.nodeId);
      return nodeId === null ? null : { ...cmd, nodeId };
    }
    case "moveNode": {
      const nodeId = map(cmd.nodeId);
      const toParentId = map(cmd.toParentId);
      return nodeId === null || toParentId === null ? null : { ...cmd, nodeId, toParentId };
    }
    case "setProps": {
      const nodeId = map(cmd.nodeId);
      return nodeId === null ? null : { ...cmd, nodeId };
    }
    case "duplicateSubtree": {
      const nodeId = map(cmd.nodeId);
      return nodeId === null ? null : { ...cmd, nodeId };
    }
    default:
      return cmd;
  }
}

function randomCommand(doc: VersoDoc, rng: () => number, nextId: () => string): VersoCommand | null {
  const ids = Object.keys(doc.nodes);
  const containers = ids.filter((id) => Object.keys(doc.nodes[id].slots).length > 0);
  const target = pick(rng, ids);
  const roll = pickInt(rng, 100);
  if (roll < 30 || !target) {
    const parent = containers.length > 0 && pickInt(rng, 3) === 0 ? pick(rng, containers)! : ROOT_ID;
    const nuevo: VersoItem =
      pickInt(rng, 5) === 0
        ? { type: "Section", props: { id: nextId(), items: [item("Card", nextId(), { title: "z" })] } }
        : item(pick(rng, ["Heading", "Text", "Card"])!, nextId(), { title: `t${pickInt(rng, 50)}` });
    return {
      kind: "insertNode",
      item: nuevo,
      parentId: parent,
      slotKey: parent === ROOT_ID ? ROOT_SLOT : "items",
      index: pickInt(rng, 4),
    };
  }
  if (roll < 45) return { kind: "removeNode", nodeId: target };
  if (roll < 60) {
    const parent = containers.length > 0 && pickInt(rng, 2) === 0 ? pick(rng, containers)! : ROOT_ID;
    return {
      kind: "moveNode",
      nodeId: target,
      toParentId: parent,
      toSlotKey: parent === ROOT_ID ? ROOT_SLOT : "items",
      toIndex: pickInt(rng, 4),
    };
  }
  if (roll < 82) {
    const key = pick(rng, ["title", "level", "gap", "nuevo"])!;
    const value = pickInt(rng, 5) === 0 ? undefined : `v${pickInt(rng, 40)}`;
    return { kind: "setProps", nodeId: target, patch: { [key]: value } };
  }
  if (roll < 92) return { kind: "setRootProps", patch: { [pick(rng, ["title", "slug"])!]: `r${pickInt(rng, 40)}` } };
  return { kind: "duplicateSubtree", nodeId: target, idMap: {} };
}

describe("Puente comando ↔ op — equivalencia con `applyCommand`", () => {
  it("500 secuencias: mismo `_puck_data` por los dos caminos", () => {
    const fallos: string[] = [];
    for (let seed = 1; seed <= 500 && fallos.length === 0; seed++) {
      const rng = mulberry32(seed * 2654435761);
      const data = sampleData();
      let doc = toNormalized(data, isSlot);
      const state = newReplica(data, "s_bridge");
      let n = 0;
      const nextId = () => `b${seed}x${(n += 1)}`;

      for (let step = 0; step < 14; step++) {
        const crdtDoc = state.toDoc();
        const cmd = randomCommand(crdtDoc, rng, nextId);
        if (!cmd) continue;

        // 1) El comando EFECTIVO sale de `applyCommand` (índices clampados,
        //    idMap materializado): es lo que la spec obliga a traducir (§3.5).
        const local = translate(cmd, crdtDoc, doc);
        if (!local) continue;
        let result;
        try {
          result = applyCommand(doc, local, { isSlot, generateId: nextId });
        } catch {
          continue; // comando inválido: no viaja
        }
        const efectivo = result.command;
        if (efectivo.kind === "history:restoreDoc") continue;
        const paraCrdt = translate(efectivo, doc, crdtDoc);
        if (!paraCrdt) continue;

        const bridged = commandToOps(state, crdtDoc, paraCrdt, bridgeOpts);
        if (!bridged.ok) continue; // el puente lo rechaza ⇒ tampoco se aplica local

        doc = result.doc;
        for (const op of bridged.ops) {
          const res = state.apply(op);
          if (res.status !== "applied") fallos.push(`seed ${seed} paso ${step}: op ${op.k} → ${res.status} ${res.code ?? ""}`);
        }
        const esperado = JSON.stringify(fromNormalized(doc));
        if (serialize(state) !== esperado) {
          fallos.push(`seed ${seed} paso ${step} (${cmd.kind}):\n  local = ${esperado}\n  crdt  = ${serialize(state)}`);
        }
      }
    }
    expect(fallos.slice(0, 3)).toEqual([]);
  });

  it("un comando que el puente no puede replicar devuelve un error TIPADO", () => {
    const state = newReplica(sampleData(), "s_a");
    const doc = state.toDoc();
    expect(commandToOps(state, doc, { kind: "setProps", nodeId: "no-existe", patch: {} }, bridgeOpts)).toMatchObject({
      ok: false,
      error: { code: "node-not-found" },
    });
    expect(
      commandToOps(state, doc, { kind: "setProps", nodeId: Object.keys(doc.nodes)[0], patch: { id: "x" } }, bridgeOpts),
    ).toMatchObject({ ok: false, error: { code: "immutable-id" } });
    expect(commandToOps(state, doc, { kind: "history:restoreDoc", doc }, bridgeOpts)).toMatchObject({
      ok: false,
      error: { code: "not-a-crdt-command" },
    });
  });

  it("`replaceData` no es una op CRDT: emite `docReset` y el núcleo lo SEÑALA", () => {
    const state = newReplica(sampleData(), "s_a");
    const res = commandToOps(state, state.toDoc(), { kind: "replaceData", data: sampleData() }, bridgeOpts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops).toHaveLength(1);
    expect(res.ops[0].k).toBe("docReset");
    const applied = state.apply(res.ops[0]);
    expect(applied.status).toBe("reset");
    expect(applied.epoch).toBe(2);
  });
});
