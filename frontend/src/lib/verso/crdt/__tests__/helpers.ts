/**
 * Utilidades compartidas por los tests del núcleo CRDT.
 *
 * REGLA DURA de esta suite: TODA aleatoriedad sale de `mulberry32` con semilla
 * fija. `Math.random` está prohibido — un fallo de convergencia que no se puede
 * reproducir no es un fallo, es un rumor.
 */

import { fromNormalized, toNormalized } from "../../normalize";
import { ROOT_ID, ROOT_SLOT, type VersoData, type VersoDoc, type VersoItem } from "../../types";
import { CrdtDoc, type CrdtDocOptions } from "../state";
import { commandToOps, type BridgeOptions } from "../bridge";
import type { CollabOp } from "../types";

/* ------------------------------------------------------------------ */
/* PRNG con semilla fija                                               */
/* ------------------------------------------------------------------ */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pickInt = (rng: () => number, n: number): number => Math.floor(rng() * n);

export function pick<T>(rng: () => number, arr: readonly T[]): T | undefined {
  return arr.length === 0 ? undefined : arr[pickInt(rng, arr.length)];
}

/** Fisher-Yates con el PRNG sembrado (jamás `sort(() => rng() - .5)`). */
export function shuffle<T>(rng: () => number, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = pickInt(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export const item = (type: string, id: string, extra: Record<string, unknown> = {}): VersoItem => ({
  type,
  props: { id, ...extra },
});

/** Documento de trabajo: bloques planos, un contenedor con slot y texto rico. */
export function sampleData(): VersoData {
  return {
    content: [
      item("Heading", "h1", { title: "Hola", level: "h2" }),
      item("Text", "t1", { content: "<p>uno</p>" }),
      {
        type: "Section",
        props: {
          id: "s1",
          gap: 8,
          items: [item("Card", "c1", { title: "A" }), item("Card", "c2", { title: "B" })],
        },
      },
    ],
    root: { props: { title: "Página", _wjs_template: "" } },
  };
}

/** El resolutor de slots de los tests: `items` es slot; `content` es texto rico. */
export const isSlot = (_type: string, key: string): boolean | undefined => (key === "items" ? true : undefined);
export const isRichText = (_type: string, key: string): boolean => key === "content";

export const bridgeOpts: BridgeOptions = { isSlot };

export function docOf(data: VersoData): VersoDoc {
  return toNormalized(data, isSlot);
}

export function newReplica(data: VersoData, site: string, opts: Partial<CrdtDocOptions> = {}): CrdtDoc {
  return CrdtDoc.fromDoc(docOf(data), { site, isRichText, now: () => 1_700_000_000_000, ...opts });
}

/** La serialización canónica: ESTE es el byte a byte que tiene que coincidir. */
export function serialize(state: CrdtDoc): string {
  return JSON.stringify(fromNormalized(state.toDoc()));
}

/**
 * Teclea `text` en el campo rico `field` de `nodo` a partir del índice `at`
 * (una op por átomo, encadenadas como lo haría el editor inline).
 */
export function typeOps(state: CrdtDoc, nodeId: string, field: string, at: number, text: string): CollabOp[] {
  const f = state.textField(nodeId, field);
  if (!f) return [];
  const ops: CollabOp[] = [];
  const inicio = f.neighborsForIndex(at);
  const right = inicio.right;
  let left = inicio.left;
  for (const ch of text.split("")) {
    const id = state.nextOpId();
    ops.push({
      k: "textInsert",
      id,
      nodeId,
      field,
      left,
      right,
      atom: { br: false, ch, marks: { bold: false, italic: false, link: null } },
      hlc: state.nextHlc(),
    });
    left = `${id.site}@${id.counter}`;
  }
  return ops;
}

/** Aplica ops a una réplica y devuelve la misma réplica (azúcar de test). */
export function feed(state: CrdtDoc, ...ops: CollabOp[][]): CrdtDoc {
  for (const batch of ops) for (const op of batch) state.apply(op);
  return state;
}

/** Ids de los hijos de la raíz en la proyección, en orden. */
export function rootIds(state: CrdtDoc): string[] {
  const doc = state.toDoc();
  return doc.rootChildren.map((id) => String(doc.nodes[id].props.id));
}

/* ------------------------------------------------------------------ */
/* Generador de comandos aleatorios                                    */
/* ------------------------------------------------------------------ */

export interface GenContext {
  rng: () => number;
  nextId: () => string;
}

/**
 * Genera ops PLAUSIBLES (las que produciría un editor de verdad) contra el
 * estado de una réplica: emite por el puente, así se ejercita el mapeo
 * comando→op además del álgebra.
 */
export function generateOps(state: CrdtDoc, ctx: GenContext): CollabOp[] {
  const doc = state.toDoc();
  const ids = Object.keys(doc.nodes);
  const rng = ctx.rng;
  const roll = pickInt(rng, 100);

  const containers = ids.filter((id) => Object.keys(doc.nodes[id].slots).length > 0);
  const target = pick(rng, ids);

  const emit = (command: Parameters<typeof commandToOps>[2]): CollabOp[] => {
    const res = commandToOps(state, doc, command, bridgeOpts);
    return res.ok ? res.ops : [];
  };

  if (roll < 26) {
    // insertNode (a veces con subtree)
    const parentPick = roll < 18 || containers.length === 0 ? null : pick(rng, containers);
    const parentId = parentPick ?? ROOT_ID;
    const slotKey = parentPick === null ? ROOT_SLOT : "items";
    const id = ctx.nextId();
    const newItem =
      pickInt(rng, 4) === 0
        ? {
            type: "Section",
            props: { id, gap: pickInt(rng, 20), items: [item("Card", ctx.nextId(), { title: "x" })] },
          }
        : item(pick(rng, ["Heading", "Text", "Card"])!, id, { title: `n${pickInt(rng, 99)}` });
    return emit({
      kind: "insertNode",
      item: newItem as VersoItem,
      parentId,
      slotKey,
      index: pickInt(rng, 4),
    });
  }

  if (roll < 40 && target) {
    return emit({ kind: "removeNode", nodeId: target });
  }

  if (roll < 55 && target) {
    const parentPick = containers.length > 0 && pickInt(rng, 2) === 0 ? pick(rng, containers) : null;
    return emit({
      kind: "moveNode",
      nodeId: target,
      toParentId: parentPick ?? ROOT_ID,
      toSlotKey: parentPick === null ? ROOT_SLOT : "items",
      toIndex: pickInt(rng, 4),
    });
  }

  if (roll < 78 && target) {
    const key = pick(rng, ["title", "gap", "level", "content", "extra"])!;
    const value = pickInt(rng, 6) === 0 ? undefined : pickInt(rng, 2) === 0 ? pickInt(rng, 999) : `v${pickInt(rng, 99)}`;
    return emit({ kind: "setProps", nodeId: target, patch: { [key]: value } });
  }

  if (roll < 88 && target) {
    // Edición fina de texto sobre un campo rico abierto.
    const field = state.textField(target, "content");
    if (!field) return [];
    const ops: CollabOp[] = [];
    const live = field.livePositions();
    if (live.length > 0 && pickInt(rng, 4) === 0) {
      const pos = live[pickInt(rng, live.length)];
      ops.push({ k: "textDelete", id: state.nextOpId(), nodeId: target, field: "content", pos, hlc: state.nextHlc() });
    } else if (live.length > 0 && pickInt(rng, 3) === 0) {
      const pos = live[pickInt(rng, live.length)];
      const mark = pick(rng, ["bold", "italic", "link"] as const)!;
      ops.push({
        k: "markSet",
        id: state.nextOpId(),
        nodeId: target,
        field: "content",
        pos,
        mark,
        value: mark === "link" ? (pickInt(rng, 2) === 0 ? null : { href: `/l${pickInt(rng, 9)}`, newTab: false }) : pickInt(rng, 2) === 0,
        hlc: state.nextHlc(),
      });
    } else {
      const at = pickInt(rng, live.length + 1);
      const { left, right } = field.neighborsForIndex(at);
      const ch = String.fromCharCode(97 + pickInt(rng, 26));
      ops.push({
        k: "textInsert",
        id: state.nextOpId(),
        nodeId: target,
        field: "content",
        left,
        right,
        atom: { br: false, ch, marks: { bold: pickInt(rng, 4) === 0, italic: false, link: null } },
        hlc: state.nextHlc(),
      });
    }
    return ops;
  }

  if (roll < 92) {
    const key = pick(rng, ["title", "_wjs_template", "seoTitle"])!;
    return emit({ kind: "setRootProps", patch: { [key]: `r${pickInt(rng, 99)}` } });
  }

  if (roll < 95) {
    // Metadatos de FORMA (D12): también se replican y también tienen que converger.
    const key = pick(rng, ["extras:_legacy", "extras:tema", "zonesKeyPresent"] as const)!;
    return [
      {
        k: "shapeSet",
        id: state.nextOpId(),
        key,
        value: key === "zonesKeyPresent" ? pickInt(rng, 2) === 0 : { v: pickInt(rng, 99) },
        hlc: state.nextHlc(),
      },
    ];
  }

  if (target && target !== ROOT_ID) {
    return emit({ kind: "duplicateSubtree", nodeId: target, idMap: {} });
  }
  return [];
}

/**
 * Simula N réplicas que editan en paralelo con entrega DESORDENADA y devuelve
 * el log global de ops (el orden del log NO es el de aplicación de nadie).
 */
export function simulateConcurrentSession(
  data: VersoData,
  replicaCount: number,
  rounds: number,
  seed: number,
): { ops: CollabOp[]; replicas: CrdtDoc[] } {
  const rng = mulberry32(seed);
  const replicas: CrdtDoc[] = [];
  for (let i = 0; i < replicaCount; i++) replicas.push(newReplica(data, `s_r${i}`));
  let ids = 0;
  const ctx: GenContext = { rng, nextId: () => `g${seed}x${(ids += 1)}` };
  const log: CollabOp[] = [];
  // Cola de entrega por réplica: la desincronización es lo que crea concurrencia real.
  const inbox: CollabOp[][] = replicas.map(() => []);

  for (let r = 0; r < rounds; r++) {
    const who = pickInt(rng, replicas.length);
    if (pickInt(rng, 100) < 62) {
      const ops = generateOps(replicas[who], ctx);
      for (const op of ops) replicas[who].apply(op);
      log.push(...ops);
      for (let i = 0; i < replicas.length; i++) if (i !== who) inbox[i].push(...ops);
    } else if (inbox[who].length > 0) {
      // Entrega FUERA DE ORDEN: se saca una op cualquiera de la bandeja.
      const at = pickInt(rng, inbox[who].length);
      const [op] = inbox[who].splice(at, 1);
      replicas[who].apply(op);
    }
  }
  // Drenaje final: todas reciben todo.
  for (let i = 0; i < replicas.length; i++) {
    for (const op of shuffle(rng, inbox[i])) replicas[i].apply(op);
  }
  return { ops: log, replicas };
}
