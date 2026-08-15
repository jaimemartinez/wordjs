/**
 * GATE F2 — comandos del motor Verso.
 *
 * Cubre cada comando y su inverso, la inmutabilidad con estructura compartida,
 * la validación tipada (VersoCommandError sin tocar el doc) y la PROPIEDAD
 * apply+inverse=identidad (deep-equal del doc serializado) sobre secuencias
 * aleatorias de 50+ comandos con PRNG de semilla fija, ejecutadas sobre 3
 * documentos sintéticos y sobre documentos del corpus real de producción.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { applyCommand, VersoCommandError, subtreeToItem } from "../commands";
import { fromNormalized, toNormalized } from "../normalize";
import {
  ROOT_ID,
  ROOT_SLOT,
  type SlotResolver,
  type VersoCommand,
  type VersoData,
  type VersoDoc,
  type VersoHistoryCommand,
  type VersoItem,
} from "../types";
import { CORPUS_PATH, item, loadVersoCorpus, type CorpusEntry } from "./helpers";

const baseData = (): VersoData => ({
  content: [
    item("Heading", "h1", { title: "Hola", level: "h2" }),
    {
      type: "Section",
      props: {
        id: "s1",
        items: [
          item("Text", "t1", { content: "a" }),
          { type: "Grid", props: { id: "g1", items: [item("Card", "c1", { title: "A" }), item("Card", "c2", { title: "B" })] } },
        ],
      },
    },
    item("Text", "t2", { content: "b" }),
    item("Tabs", "tb", { panels: [] }),
  ],
  root: { props: { title: "Página", _wjs_template: "" } },
});

const docOf = (d: VersoData = baseData()): VersoDoc => toNormalized(d);

/** Aplica cmd verificando que el doc de entrada NO se muta (byte-a-byte serializado). */
function applyChecked(doc: VersoDoc, cmd: VersoHistoryCommand, opts?: Parameters<typeof applyCommand>[2]) {
  const snapshot = JSON.stringify(fromNormalized(doc));
  const result = applyCommand(doc, cmd, opts);
  expect(JSON.stringify(fromNormalized(doc))).toBe(snapshot);
  return result;
}

/** apply + inverse = identidad del doc serializado. */
function roundTripCmd(doc: VersoDoc, cmd: VersoHistoryCommand, opts?: Parameters<typeof applyCommand>[2]) {
  const before = fromNormalized(doc);
  const fwd = applyChecked(doc, cmd, opts);
  const back = applyChecked(fwd.doc, fwd.inverse, opts);
  expect(fromNormalized(back.doc)).toEqual(before);
  return fwd;
}

describe("verso commands — insertNode", () => {
  it("inserta en la raíz, recalcula índices de hermanos y su inverso es removeNode exacto", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, {
      kind: "insertNode",
      item: item("Text", "nuevo", { content: "n" }),
      parentId: ROOT_ID,
      slotKey: ROOT_SLOT,
      index: 1,
    });
    expect(fwd.inverse).toEqual({ kind: "removeNode", nodeId: "nuevo" });
    expect(fwd.doc.rootChildren).toEqual(["h1", "nuevo", "s1", "t2", "tb"]);
    expect(fwd.doc.nodes["nuevo"].index).toBe(1);
    // hermanos desplazados reindexados EN LAS COPIAS:
    expect(fwd.doc.nodes["s1"].index).toBe(2);
    expect(fwd.doc.nodes["t2"].index).toBe(3);
  });

  it("interna un subtree anidado completo (slots recursivos)", () => {
    const doc = docOf();
    const sub = {
      type: "Grid",
      props: { id: "gx", items: [item("Card", "cx1"), item("Card", "cx2")] },
    };
    const fwd = roundTripCmd(doc, { kind: "insertNode", item: sub, parentId: "s1", slotKey: "items", index: 0 });
    expect(fwd.doc.nodes["gx"].slots.items).toEqual(["cx1", "cx2"]);
    expect(fwd.doc.nodes["cx1"].parentId).toBe("gx");
    expect(fwd.doc.nodes["t1"].index).toBe(1);
  });

  it("índice fuera de rango se clampa y el comando efectivo lleva el índice clampado", () => {
    const doc = docOf();
    const fwd = applyChecked(doc, {
      kind: "insertNode",
      item: item("Text", "fin"),
      parentId: ROOT_ID,
      slotKey: ROOT_SLOT,
      index: 99,
    });
    expect(fwd.doc.rootChildren[fwd.doc.rootChildren.length - 1]).toBe("fin");
    expect((fwd.command as { index: number }).index).toBe(4);
    const neg = applyChecked(doc, {
      kind: "insertNode",
      item: item("Text", "ini"),
      parentId: ROOT_ID,
      slotKey: ROOT_SLOT,
      index: -5,
    });
    expect(neg.doc.rootChildren[0]).toBe("ini");
  });

  it("un array vacío en props se promociona a slot al insertar — serialización idéntica tras el inverso", () => {
    const doc = docOf();
    expect(doc.nodes["tb"].props.panels).toEqual([]); // sin resolver: prop
    const fwd = roundTripCmd(doc, {
      kind: "insertNode",
      item: item("Text", "p1", { content: "panel" }),
      parentId: "tb",
      slotKey: "panels",
      index: 0,
    });
    expect(fwd.doc.nodes["tb"].slots.panels).toEqual(["p1"]);
    expect("panels" in fwd.doc.nodes["tb"].props).toBe(false);
  });

  it("padre o slot inexistente → VersoCommandError sin tocar el doc", () => {
    const doc = docOf();
    const snapshot = JSON.stringify(fromNormalized(doc));
    expect(() =>
      applyCommand(doc, { kind: "insertNode", item: item("Text", "x"), parentId: "ghost", slotKey: "items", index: 0 }),
    ).toThrow(VersoCommandError);
    expect(() =>
      applyCommand(doc, { kind: "insertNode", item: item("Text", "x"), parentId: "h1", slotKey: "items", index: 0 }),
    ).toThrow(VersoCommandError);
    expect(() =>
      applyCommand(doc, { kind: "insertNode", item: item("Text", "x"), parentId: ROOT_ID, slotKey: "otra", index: 0 }),
    ).toThrow(VersoCommandError);
    expect(JSON.stringify(fromNormalized(doc))).toBe(snapshot);
  });

  it("item inválido → bad-command", () => {
    const doc = docOf();
    expect(() =>
      applyCommand(doc, {
        kind: "insertNode",
        item: { type: "Text" } as unknown as VersoItem,
        parentId: ROOT_ID,
        slotKey: ROOT_SLOT,
        index: 0,
      }),
    ).toThrow(VersoCommandError);
  });

  it("field array declarado NO-slot con valor []: insertNode lanza slot-not-insertable SIEMPRE", () => {
    // El registry dice que Tabs.panels es un field `array` (declared=false): la
    // forma [] del valor en runtime NO lo re-clasifica como insertable.
    const isSlot: SlotResolver = (t, k) => (t === "Tabs" && k === "panels" ? false : undefined);
    const doc = toNormalized(baseData(), isSlot);
    expect(doc.nodes["tb"].props.panels).toEqual([]);
    const snapshot = JSON.stringify(fromNormalized(doc));
    let err: unknown;
    try {
      applyCommand(
        doc,
        { kind: "insertNode", item: item("Text", "x"), parentId: "tb", slotKey: "panels", index: 0 },
        { isSlot },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VersoCommandError);
    expect((err as VersoCommandError).code).toBe("slot-not-insertable");
    expect(JSON.stringify(fromNormalized(doc))).toBe(snapshot);
    // moveNode hacia ese pseudo-slot también se rechaza (mismo camino de resolución).
    expect(() =>
      applyCommand(
        doc,
        { kind: "moveNode", nodeId: "t2", toParentId: "tb", toSlotKey: "panels", toIndex: 0 },
        { isSlot },
      ),
    ).toThrow(VersoCommandError);
  });

  it("slot declarado SIN clave en el item: insertNode crea el slot (y el inverso lo deja vacío)", () => {
    const isSlot: SlotResolver = (t, k) => (t === "Tabs" && k === "extra" ? true : undefined);
    const doc = toNormalized(baseData(), isSlot);
    expect("extra" in doc.nodes["tb"].props).toBe(false);
    expect("extra" in doc.nodes["tb"].slots).toBe(false);
    const fwd = applyChecked(
      doc,
      { kind: "insertNode", item: item("Text", "nx", { content: "n" }), parentId: "tb", slotKey: "extra", index: 0 },
      { isSlot },
    );
    expect(fwd.doc.nodes["tb"].slots.extra).toEqual(["nx"]);
    expect(fwd.doc.nodes["nx"].parentId).toBe("tb");
  });
});

describe("verso commands — removeNode", () => {
  it("captura el SUBTREE entero en el inverso y lo reinsertar restaura todo", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, { kind: "removeNode", nodeId: "g1" });
    // subtree completo fuera del mapa:
    expect(fwd.doc.nodes["g1"]).toBeUndefined();
    expect(fwd.doc.nodes["c1"]).toBeUndefined();
    expect(fwd.doc.nodes["c2"]).toBeUndefined();
    expect(fwd.doc.nodes["s1"].slots.items).toEqual(["t1"]);
    // inverso = insertNode con el subtree serializado y la posición original:
    expect(fwd.inverse).toEqual({
      kind: "insertNode",
      item: {
        type: "Grid",
        props: { id: "g1", items: [item("Card", "c1", { title: "A" }), item("Card", "c2", { title: "B" })] },
      },
      parentId: "s1",
      slotKey: "items",
      index: 1,
    });
  });

  it("reindexación de hermanos al remover de la raíz", () => {
    const doc = docOf();
    const fwd = applyChecked(doc, { kind: "removeNode", nodeId: "h1" });
    expect(fwd.doc.rootChildren).toEqual(["s1", "t2", "tb"]);
    expect(fwd.doc.nodes["s1"].index).toBe(0);
    expect(fwd.doc.nodes["t2"].index).toBe(1);
  });

  it("nodo inexistente → node-not-found sin tocar el doc", () => {
    const doc = docOf();
    const snapshot = JSON.stringify(fromNormalized(doc));
    let err: unknown;
    try {
      applyCommand(doc, { kind: "removeNode", nodeId: "nope" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VersoCommandError);
    expect((err as VersoCommandError).code).toBe("node-not-found");
    expect(JSON.stringify(fromNormalized(doc))).toBe(snapshot);
  });
});

describe("verso commands — moveNode", () => {
  it("reordena dentro del mismo slot con semántica post-remoción, inverso exacto", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, { kind: "moveNode", nodeId: "h1", toParentId: ROOT_ID, toSlotKey: ROOT_SLOT, toIndex: 2 });
    expect(fwd.doc.rootChildren).toEqual(["s1", "t2", "h1", "tb"]);
    expect(fwd.inverse).toEqual({ kind: "moveNode", nodeId: "h1", toParentId: ROOT_ID, toSlotKey: ROOT_SLOT, toIndex: 0 });
  });

  it("mueve entre padres distintos y reindexa ambos lados", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, { kind: "moveNode", nodeId: "t1", toParentId: ROOT_ID, toSlotKey: ROOT_SLOT, toIndex: 0 });
    expect(fwd.doc.rootChildren).toEqual(["t1", "h1", "s1", "t2", "tb"]);
    expect(fwd.doc.nodes["t1"].parentId).toBe(ROOT_ID);
    expect(fwd.doc.nodes["s1"].slots.items).toEqual(["g1"]);
    expect(fwd.doc.nodes["g1"].index).toBe(0);
  });

  it("mover un nodo DENTRO de su propio subtree (o a sí mismo) → cycle sin tocar el doc", () => {
    const doc = docOf();
    const snapshot = JSON.stringify(fromNormalized(doc));
    for (const toParentId of ["g1", "s1"]) {
      let err: unknown;
      try {
        applyCommand(doc, { kind: "moveNode", nodeId: "s1", toParentId, toSlotKey: "items", toIndex: 0 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(VersoCommandError);
      expect((err as VersoCommandError).code).toBe("cycle");
    }
    expect(JSON.stringify(fromNormalized(doc))).toBe(snapshot);
  });

  it("toIndex fuera de rango se clampa; el inverso restaura la posición original", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, { kind: "moveNode", nodeId: "c1", toParentId: "g1", toSlotKey: "items", toIndex: 42 });
    expect(fwd.doc.nodes["g1"].slots.items).toEqual(["c2", "c1"]);
    expect((fwd.command as { toIndex: number }).toIndex).toBe(1);
  });

  it("mover a un slot vacío promocionado desde prop-[]", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, { kind: "moveNode", nodeId: "t2", toParentId: "tb", toSlotKey: "panels", toIndex: 0 });
    expect(fwd.doc.nodes["tb"].slots.panels).toEqual(["t2"]);
    expect(fwd.doc.rootChildren).toEqual(["h1", "s1", "tb"]);
  });
});

describe("verso commands — setProps", () => {
  it("merge superficial; undefined ELIMINA la clave; el inverso restaura valores previos y elimina las añadidas", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, {
      kind: "setProps",
      nodeId: "h1",
      patch: { title: undefined, nueva: 7, level: "h3" },
    });
    expect("title" in fwd.doc.nodes["h1"].props).toBe(false);
    expect(fwd.doc.nodes["h1"].props.nueva).toBe(7);
    expect(fwd.doc.nodes["h1"].props.level).toBe("h3");
    expect(fwd.inverse).toEqual({
      kind: "setProps",
      nodeId: "h1",
      patch: { title: "Hola", nueva: undefined, level: "h2" },
    });
  });

  it("id inmutable y claves de slot rechazadas, sin tocar el doc", () => {
    const doc = docOf();
    const snapshot = JSON.stringify(fromNormalized(doc));
    expect(() => applyCommand(doc, { kind: "setProps", nodeId: "h1", patch: { id: "otro" } })).toThrow(VersoCommandError);
    expect(() => applyCommand(doc, { kind: "setProps", nodeId: "s1", patch: { items: "x" } })).toThrow(VersoCommandError);
    expect(() => applyCommand(doc, { kind: "setProps", nodeId: "ghost", patch: { a: 1 } })).toThrow(VersoCommandError);
    expect(JSON.stringify(fromNormalized(doc))).toBe(snapshot);
  });
});

describe("verso commands — setRootProps", () => {
  it("igual que setProps sobre doc.root.props, con inverso exacto", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, { kind: "setRootProps", patch: { title: "Otra", extra: 1, _wjs_template: undefined } });
    const props = fwd.doc.root.props as Record<string, unknown>;
    expect(props.title).toBe("Otra");
    expect(props.extra).toBe(1);
    expect("_wjs_template" in props).toBe(false);
    expect(fwd.inverse).toEqual({
      kind: "setRootProps",
      patch: { title: "Página", extra: undefined, _wjs_template: "" },
    });
  });

  it("root SIN props: el forward materializa props y el inverso exacto es history:restoreDoc", () => {
    const doc = toNormalized({ content: [item("Text", "t1")] } as unknown as VersoData);
    const fwd = roundTripCmd(doc, { kind: "setRootProps", patch: { title: "x" } });
    expect((fwd.doc.root.props as Record<string, unknown>).title).toBe("x");
    expect(fwd.inverse.kind).toBe("history:restoreDoc");
    // restaura el doc previo VERBATIM (misma referencia):
    expect((fwd.inverse as { doc: VersoDoc }).doc).toBe(doc);
  });
});

describe("verso commands — duplicateSubtree", () => {
  it("duplica el subtree entero con idMap del llamador, insertando justo después del original", () => {
    const doc = docOf();
    const fwd = roundTripCmd(doc, {
      kind: "duplicateSubtree",
      nodeId: "g1",
      idMap: { g1: "g1b", c1: "c1b", c2: "c2b" },
    });
    expect(fwd.doc.nodes["s1"].slots.items).toEqual(["t1", "g1", "g1b"]);
    expect(fwd.doc.nodes["g1b"].slots.items).toEqual(["c1b", "c2b"]);
    expect(fwd.doc.nodes["c1b"].props).toEqual({ id: "c1b", title: "A" });
    expect(fwd.inverse).toEqual({ kind: "removeNode", nodeId: "g1b" });
  });

  it("sin idMap usa generateId y el comando efectivo materializa el idMap (redo determinista)", () => {
    const doc = docOf();
    let n = 0;
    const opts = { generateId: () => `gen-${++n}` };
    const fwd = applyChecked(doc, { kind: "duplicateSubtree", nodeId: "g1" }, opts);
    const effective = fwd.command as { idMap: Record<string, string> };
    expect(effective.idMap).toEqual({ g1: "gen-1", c1: "gen-2", c2: "gen-3" });
    // re-aplicar el comando efectivo sobre el doc original reproduce el MISMO resultado:
    const again = applyCommand(doc, fwd.command, opts);
    expect(fromNormalized(again.doc)).toEqual(fromNormalized(fwd.doc));
  });

  it("nodo inexistente → node-not-found", () => {
    expect(() => applyCommand(docOf(), { kind: "duplicateSubtree", nodeId: "nope" })).toThrow(VersoCommandError);
  });
});

describe("verso commands — replaceData", () => {
  it("sustituye el documento y el inverso es history:restoreDoc con el doc previo verbatim", () => {
    const doc = docOf();
    const next: VersoData = { content: [item("Text", "solo", { content: "z" })], root: { props: { title: "N" } } };
    const fwd = roundTripCmd(doc, { kind: "replaceData", data: next });
    expect(fromNormalized(fwd.doc)).toEqual(next);
    expect(fwd.inverse.kind).toBe("history:restoreDoc");
    // el inverso restaura el doc previo VERBATIM (misma referencia), preservando
    // metadatos de forma no serializables (contentKeyState, etc.):
    const restore = fwd.inverse as { doc: VersoDoc };
    expect(restore.doc).toBe(doc);
    expect(fromNormalized(restore.doc)).toEqual(baseData());
    // aplicar el inverso publica ese doc tal cual:
    expect(applyCommand(fwd.doc, fwd.inverse).doc).toBe(doc);
  });
});

describe("verso commands — inmutabilidad y estructura compartida", () => {
  it("los nodos NO afectados conservan la MISMA referencia; los afectados son copias", () => {
    const doc = docOf();
    const fwd = applyCommand(doc, { kind: "setProps", nodeId: "t1", patch: { content: "zz" } });
    expect(fwd.doc).not.toBe(doc);
    expect(fwd.doc.nodes).not.toBe(doc.nodes);
    expect(fwd.doc.nodes["t1"]).not.toBe(doc.nodes["t1"]);
    // intocados: misma referencia (estructura compartida)
    for (const k of ["h1", "s1", "g1", "c1", "c2", "t2", "tb"]) {
      expect(fwd.doc.nodes[k]).toBe(doc.nodes[k]);
    }
    expect(fwd.doc.rootChildren).toBe(doc.rootChildren);
    expect(doc.nodes["t1"].props.content).toBe("a");
  });

  it("insertNode copia solo el camino afectado", () => {
    const doc = docOf();
    const fwd = applyCommand(doc, {
      kind: "insertNode",
      item: item("Card", "c3"),
      parentId: "g1",
      slotKey: "items",
      index: 2,
    });
    expect(fwd.doc.nodes["g1"]).not.toBe(doc.nodes["g1"]);
    expect(fwd.doc.nodes["s1"]).toBe(doc.nodes["s1"]);
    expect(fwd.doc.nodes["c1"]).toBe(doc.nodes["c1"]);
    expect(fwd.doc.rootChildren).toBe(doc.rootChildren);
  });

  it("subtreeToItem serializa el subtree igual que la serialización global", () => {
    const doc = docOf();
    expect(subtreeToItem(doc, "s1")).toEqual((baseData().content as VersoItem[])[1]);
  });
});

/* ------------------------------------------------------------------ */
/* PROPIEDAD: apply + inverse = identidad, secuencias aleatorias.      */
/* PRNG con semilla fija (mulberry32) — sin Math.random.               */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickInt = (rng: () => number, n: number): number => Math.floor(rng() * n);

function insertTargets(doc: VersoDoc): Array<{ parentId: string; slotKey: string }> {
  const out: Array<{ parentId: string; slotKey: string }> = [{ parentId: ROOT_ID, slotKey: ROOT_SLOT }];
  for (const node of Object.values(doc.nodes)) {
    for (const sk of Object.keys(node.slots)) out.push({ parentId: node.id, slotKey: sk });
    for (const [k, v] of Object.entries(node.props)) {
      if (k !== "id" && Array.isArray(v) && v.length === 0) out.push({ parentId: node.id, slotKey: k });
    }
  }
  return out;
}

function targetLength(doc: VersoDoc, t: { parentId: string; slotKey: string }): number {
  if (t.parentId === ROOT_ID) return doc.rootChildren.length;
  return doc.nodes[t.parentId].slots[t.slotKey]?.length ?? 0;
}

function subtreeSet(doc: VersoDoc, key: string): Set<string> {
  const out = new Set<string>();
  const stack = [key];
  while (stack.length > 0) {
    const k = stack.pop() as string;
    if (out.has(k)) continue;
    out.add(k);
    const n = doc.nodes[k];
    if (n) for (const children of Object.values(n.slots)) stack.push(...children);
  }
  return out;
}

function randomCommand(doc: VersoDoc, rng: () => number, nextId: () => string): VersoCommand | null {
  const keys = Object.keys(doc.nodes);
  const roll = rng();
  if (keys.length === 0 || roll < 0.3) {
    const targets = insertTargets(doc);
    const t = targets[pickInt(rng, targets.length)];
    const id = nextId();
    const nested = rng() < 0.3;
    const newItem: VersoItem = nested
      ? { type: "Grid", props: { id, items: [item("Card", nextId(), { title: "x" })] } }
      : item("Text", id, { content: `c-${id}` });
    const index = pickInt(rng, targetLength(doc, t) + 3) - 1; // ejercita el clamp
    return { kind: "insertNode", item: newItem, parentId: t.parentId, slotKey: t.slotKey, index };
  }
  if (roll < 0.5) {
    const key = keys[pickInt(rng, keys.length)];
    const node = doc.nodes[key];
    const patch: Record<string, unknown> = {};
    const editable = Object.keys(node.props).filter((k) => k !== "id" && !(k in node.slots));
    if (editable.length > 0 && rng() < 0.5) {
      patch[editable[pickInt(rng, editable.length)]] = rng() < 0.4 ? undefined : `v${pickInt(rng, 1000)}`;
    }
    const fresh = `zz${pickInt(rng, 4)}`;
    if (!(fresh in node.slots)) patch[fresh] = rng() < 0.3 ? undefined : pickInt(rng, 1000);
    if (Object.keys(patch).length === 0) return null;
    return { kind: "setProps", nodeId: key, patch };
  }
  if (roll < 0.6) {
    const patch: Record<string, unknown> = {};
    patch[`rt${pickInt(rng, 3)}`] = rng() < 0.3 ? undefined : `r${pickInt(rng, 100)}`;
    return { kind: "setRootProps", patch };
  }
  if (roll < 0.75) {
    const key = keys[pickInt(rng, keys.length)];
    const forbidden = subtreeSet(doc, key);
    const targets = insertTargets(doc).filter((t) => !forbidden.has(t.parentId));
    if (targets.length === 0) return null;
    const t = targets[pickInt(rng, targets.length)];
    return {
      kind: "moveNode",
      nodeId: key,
      toParentId: t.parentId,
      toSlotKey: t.slotKey,
      toIndex: pickInt(rng, targetLength(doc, t) + 2),
    };
  }
  if (roll < 0.9) {
    return { kind: "removeNode", nodeId: keys[pickInt(rng, keys.length)] };
  }
  return { kind: "duplicateSubtree", nodeId: keys[pickInt(rng, keys.length)] };
}

function runIdentityProperty(data: VersoData, seed: number, minCommands = 50): void {
  const rng = mulberry32(seed);
  let seq = 0;
  const nextId = () => `pp${seed}x${++seq}`;
  const doc0 = toNormalized(data);
  const before = fromNormalized(doc0);
  const beforeJson = JSON.stringify(before);
  let doc = doc0;
  const inverses: VersoHistoryCommand[] = [];
  let applied = 0;
  for (let i = 0; applied < minCommands && i < 800; i++) {
    const cmd = randomCommand(doc, rng, nextId);
    if (!cmd) continue;
    const result = applyCommand(doc, cmd, { generateId: nextId });
    doc = result.doc;
    inverses.push(result.inverse);
    applied += 1;
  }
  expect(applied).toBeGreaterThanOrEqual(minCommands);
  for (let i = inverses.length - 1; i >= 0; i--) {
    doc = applyCommand(doc, inverses[i], { generateId: nextId }).doc;
  }
  expect(fromNormalized(doc)).toEqual(before);
  // El doc inicial jamás se mutó en todo el proceso:
  expect(JSON.stringify(fromNormalized(doc0))).toBe(beforeJson);
}

describe("verso commands — propiedad apply+inverse=identidad (PRNG semilla fija)", () => {
  const synthetic: Array<[string, VersoData]> = [
    ["plano", baseData()],
    [
      "anidado profundo con slots vacíos",
      {
        content: [
          {
            type: "Section",
            props: {
              id: "sec",
              items: [
                {
                  type: "Columns",
                  props: {
                    id: "cols",
                    "col-0": [item("Text", "a1", { content: "x" })],
                    "col-1": [{ type: "Grid", props: { id: "gg", items: [item("Card", "k1"), item("Card", "k2")] } }],
                    "col-2": [],
                  },
                },
              ],
            },
          },
          item("Spacer", "sp", { size: 24 }),
        ],
        root: { props: { title: "N", _wjs_template: "landing" } },
      },
    ],
    [
      "quirks: content ausente + root sin props + extras verbatim",
      { root: {}, futureKey: { anything: 1 } } as unknown as VersoData,
    ],
  ];

  for (const [name, data] of synthetic) {
    it(`doc sintético "${name}" — 3 semillas × 50+ comandos`, () => {
      for (const seed of [1, 42, 20260815]) runIdentityProperty(data, seed);
    });
  }
});

/* ------------------------------------------------------------------ */
/* Corpus real de producción (gitignorado — skipIf cuando falta).      */
/* ------------------------------------------------------------------ */

const corpusAvailable = existsSync(CORPUS_PATH);

describe.skipIf(!corpusAvailable)("verso commands — propiedad sobre corpus de producción", () => {
  const entries: CorpusEntry[] = loadVersoCorpus();

  // Los 3 documentos con más bloques (y sin ids duplicados, que desestabilizarían
  // las claves internas #dupN durante remove/reinsert).
  const picked = entries
    .filter((e) => Array.isArray(e.puckData?.content))
    .filter((e) => toNormalized(e.puckData).warnings.every((w) => !w.includes("duplicado")))
    .sort((a, b) => Object.keys(toNormalized(b.puckData).nodes).length - Object.keys(toNormalized(a.puckData).nodes).length)
    .slice(0, 3);

  it("hay documentos que ejercitar", () => {
    expect(picked.length).toBeGreaterThan(0);
  });

  for (const entry of picked) {
    it(`doc ${entry.id} (${entry.type}) — 2 semillas × 50+ comandos`, () => {
      // Base = forma ya normalizada (los docs con zones migran zones→slots al
      // entrar al editor; la identidad se mide contra ESA base, como en el gate
      // de round-trip).
      const base = fromNormalized(toNormalized(entry.puckData));
      for (const seed of [7, 1234]) runIdentityProperty(base, seed);
    });
  }
});
