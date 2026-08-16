/**
 * Verso CRDT — puente COMANDO ↔ OPERACIÓN (§3.2).
 *
 * Traduce los `VersoCommand` (la única vía de escritura del editor) al catálogo
 * de ops replicables, y nada más: aquí no hay red, ni store, ni UI. Reglas que
 * la spec fija y este módulo materializa:
 *
 * - `insertNode` → `nodeCreate` + `listInsert`. El `index` del comando se
 *   traduce a POSICIONES `(left,right)` leyendo la lista viva: un índice jamás
 *   viaja por el canal — un índice concurrente ES el interleaving que D1 evita.
 * - `moveNode` → `listMove` PRIMITIVO (D10). Nunca `remove`+`insert`: eso
 *   duplica bajo concurrencia (arXiv:2311.14007).
 * - `removeNode` → `nodeDelete` (no recursivo, §3.2.2).
 * - `setProps` → `propSet`/`propDelete` por clave, salvo campos de texto rico
 *   ABIERTOS, que se difieren al canal de texto (§3.2.3): un pegado de HTML
 *   entero se trata como REEMPLAZO (borrar lo vivo + insertar lo nuevo).
 * - `setRootProps` → `propSet`/`propDelete` sobre `ROOT_ID`.
 * - `duplicateSubtree` → se EXPANDE en el emisor con el `idMap` ya
 *   materializado (no es una op CRDT: duplicar no tiene semántica concurrente).
 * - `replaceData` → `docReset` (D11), el único que no se expresa como CRDT.
 *
 * IMPORTANTE: hay que traducir el comando EFECTIVO que devuelve `applyCommand`
 * (índices clampados, `idMap` resuelto), no el crudo, o emisor y receptor
 * aplicarían cosas distintas (§3.5).
 */

import { classifySlotProp } from "../normalize";
import { subtreeToItem } from "../commands";
import {
  ROOT_ID,
  type SlotResolver,
  type VersoDoc,
  type VersoHistoryCommand,
  type VersoItem,
} from "../types";
import { paraToAtoms, parseRichHtml, sameMarks, type Atom } from "../inline-engine";
import { opIdKey, type PosRef } from "./identity";
import { setOwn } from "./objects";
import type { CrdtDoc } from "./state";
import type { CollabOp } from "./types";

export type BridgeErrorCode =
  | "bad-command"
  | "node-not-found"
  | "parent-not-found"
  | "slot-not-insertable"
  | "slot-prop-conflict"
  | "immutable-id"
  | "cycle"
  | "not-a-crdt-command";

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

export type BridgeResult = { ok: true; ops: CollabOp[] } | { ok: false; error: BridgeError };

export interface BridgeOptions {
  /** Mismo resolutor de slots que usan `toNormalized`/`applyCommand`. */
  isSlot?: SlotResolver;
  /** Ids frescos para `duplicateSubtree` cuando el `idMap` no cubre el subtree. */
  generateId?: () => string;
}

const fail = (code: BridgeErrorCode, message: string): BridgeResult => ({ ok: false, error: { code, message } });

/**
 * Traduce un comando efectivo a ops. `doc` es la proyección VIGENTE del estado
 * (`state.toDoc()`), que es de donde salen índices, subtrees y clasificación de
 * slots — el estado CRDT y su proyección no pueden discrepar.
 */
export function commandToOps(
  state: CrdtDoc,
  doc: VersoDoc,
  command: VersoHistoryCommand,
  opts: BridgeOptions = {},
): BridgeResult {
  switch (command.kind) {
    case "insertNode": {
      if (!isItem(command.item)) return fail("bad-command", "insertNode.item no es un VersoItem válido");
      const parentId = command.parentId;
      if (parentId !== ROOT_ID && !Object.hasOwn(doc.nodes, parentId)) {
        return fail("parent-not-found", `padre "${parentId}" inexistente`);
      }
      const parentType = parentId === ROOT_ID ? "" : doc.nodes[parentId].type;
      if (parentId !== ROOT_ID && opts.isSlot?.(parentType, command.slotKey) === false) {
        return fail("slot-not-insertable", `"${parentId}.${command.slotKey}" está declarado NO-slot`);
      }
      const ops: CollabOp[] = [];
      const nodeId = emitSubtree(state, command.item, opts, ops);
      const { left, right } = state.neighborsForIndex(parentId, command.slotKey, command.index);
      ops.push({
        k: "listInsert",
        id: state.nextOpId(),
        parentId,
        slotKey: command.slotKey,
        left,
        right,
        nodeId,
      });
      return { ok: true, ops };
    }

    case "removeNode": {
      if (!state.hasNode(command.nodeId)) return fail("node-not-found", `nodo "${command.nodeId}" inexistente`);
      return {
        ok: true,
        ops: [{ k: "nodeDelete", id: state.nextOpId(), nodeId: command.nodeId, hlc: state.nextHlc() }],
      };
    }

    case "moveNode": {
      if (!state.hasNode(command.nodeId)) return fail("node-not-found", `nodo "${command.nodeId}" inexistente`);
      if (command.toParentId !== ROOT_ID && !state.hasNode(command.toParentId)) {
        return fail("parent-not-found", `padre "${command.toParentId}" inexistente`);
      }
      if (isInSubtree(doc, command.nodeId, command.toParentId)) {
        return fail("cycle", `no se puede mover "${command.nodeId}" dentro de su propio subtree`);
      }
      const { left, right } = state.neighborsForMove(
        command.toParentId,
        command.toSlotKey,
        command.toIndex,
        command.nodeId,
      );
      return {
        ok: true,
        ops: [
          {
            k: "listMove",
            id: state.nextOpId(),
            nodeId: command.nodeId,
            toParentId: command.toParentId,
            toSlotKey: command.toSlotKey,
            left,
            right,
            hlc: state.nextHlc(),
          },
        ],
      };
    }

    case "setProps": {
      const node = Object.hasOwn(doc.nodes, command.nodeId) ? doc.nodes[command.nodeId] : undefined;
      if (!node || !state.hasNode(command.nodeId)) {
        return fail("node-not-found", `nodo "${command.nodeId}" inexistente`);
      }
      if (!isPlainObject(command.patch)) return fail("bad-command", "setProps.patch debe ser un objeto plano");
      if (Object.hasOwn(command.patch, "id")) return fail("immutable-id", "setProps: `id` es inmutable");
      const ops: CollabOp[] = [];
      for (const [key, value] of Object.entries(command.patch)) {
        if (Object.hasOwn(node.slots, key)) {
          return fail("slot-prop-conflict", `setProps: "${key}" es un slot de "${command.nodeId}"`);
        }
        const field = state.textField(command.nodeId, key);
        if (field && value !== undefined) {
          emitTextEdit(state, command.nodeId, key, value, ops);
          continue;
        }
        if (value === undefined) {
          ops.push({ k: "propDelete", id: state.nextOpId(), nodeId: command.nodeId, key, hlc: state.nextHlc() });
        } else {
          ops.push({ k: "propSet", id: state.nextOpId(), nodeId: command.nodeId, key, value, hlc: state.nextHlc() });
        }
      }
      return { ok: true, ops };
    }

    case "setRootProps": {
      if (!isPlainObject(command.patch)) return fail("bad-command", "setRootProps.patch debe ser un objeto plano");
      const ops: CollabOp[] = [];
      for (const [key, value] of Object.entries(command.patch)) {
        if (value === undefined) {
          ops.push({ k: "propDelete", id: state.nextOpId(), nodeId: ROOT_ID, key, hlc: state.nextHlc() });
        } else {
          ops.push({ k: "propSet", id: state.nextOpId(), nodeId: ROOT_ID, key, value, hlc: state.nextHlc() });
        }
      }
      return { ok: true, ops };
    }

    case "duplicateSubtree": {
      const node = Object.hasOwn(doc.nodes, command.nodeId) ? doc.nodes[command.nodeId] : undefined;
      if (!node) return fail("node-not-found", `nodo "${command.nodeId}" inexistente`);
      let item: VersoItem;
      try {
        item = subtreeToItem(doc, command.nodeId);
      } catch {
        return fail("node-not-found", `subtree de "${command.nodeId}" ilegible`);
      }
      const idMap: Record<string, string> = { ...(command.idMap ?? {}) };
      let seq = 0;
      const gen = opts.generateId ?? (() => `${opIdKey(state.nextOpId())}#${(seq += 1)}`);
      const copy = remapIds(item, idMap, gen, opts.isSlot);
      const ops: CollabOp[] = [];
      const nodeId = emitSubtree(state, copy, opts, ops);
      const { left, right } = state.neighborsForIndex(node.parentId, node.slotKey, node.index + 1);
      ops.push({
        k: "listInsert",
        id: state.nextOpId(),
        parentId: node.parentId,
        slotKey: node.slotKey,
        left,
        right,
        nodeId,
      });
      return { ok: true, ops };
    }

    case "replaceData": {
      if (!isPlainObject(command.data)) return fail("bad-command", "replaceData.data debe ser un objeto VersoData");
      return {
        ok: true,
        ops: [
          {
            k: "docReset",
            id: state.nextOpId(),
            epoch: state.epoch + 1,
            snapshotHash: hashJson(command.data),
          },
        ],
      };
    }

    default:
      // `history:restoreDoc` es interno de la historia local (no viaja).
      return fail("not-a-crdt-command", `comando no replicable: ${String((command as { kind?: unknown }).kind)}`);
  }
}

/* ------------------------------------------------------------------ */

/** Emite `nodeCreate` + `listInsert` de un subtree completo. Devuelve su nodeId. */
function emitSubtree(state: CrdtDoc, item: VersoItem, opts: BridgeOptions, out: CollabOp[]): string {
  const createId = state.nextOpId();
  const nodeId = opIdKey(createId);
  const props: Record<string, unknown> = {};
  const propOrder: string[] = [];
  const slotKeys: string[] = [];
  const children: { key: string; items: VersoItem[] }[] = [];
  for (const [k, v] of Object.entries(item.props)) {
    if (k !== "id" && classifySlotProp(opts.isSlot?.(item.type, k), v)) {
      slotKeys.push(k);
      children.push({ key: k, items: v as VersoItem[] });
    } else {
      setOwn(props, k, v);
      propOrder.push(k);
    }
  }
  if (!Object.hasOwn(props, "id")) {
    props.id = item.props.id;
    propOrder.push("id");
  }
  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(item)) {
    if (k !== "type" && k !== "props") setOwn(extras, k, (item as unknown as Record<string, unknown>)[k]);
  }
  out.push({
    k: "nodeCreate",
    id: createId,
    nodeId,
    type: item.type,
    props,
    propOrder,
    slotKeys,
    // Espejo EXACTO de `normalizeItem`/`internItem`: el orden original solo se
    // materializa cuando el item tiene ≥1 slot.
    keyOrder: slotKeys.length > 0 ? Object.keys(item.props) : undefined,
    extras: Object.keys(extras).length > 0 ? extras : undefined,
    hlc: state.nextHlc(),
  });
  for (const slot of children) {
    let left: PosRef | null = null;
    for (const child of slot.items) {
      if (!isItem(child)) continue;
      const childId = emitSubtree(state, child, opts, out);
      const insertId = state.nextOpId();
      out.push({
        k: "listInsert",
        id: insertId,
        parentId: nodeId,
        slotKey: slot.key,
        left,
        right: null,
        nodeId: childId,
      });
      left = opIdKey(insertId);
    }
  }
  return nodeId;
}

/**
 * Edición de un campo de texto ABIERTO (§3.2.3) como DIFERENCIA MÍNIMA.
 *
 * POR QUÉ NO UN REEMPLAZO ENTERO (el defecto que este código arregla): un
 * `setProps` de texto rico llega con el HTML COMPLETO del campo — es lo único
 * que la superficie inline sabe emitir. Traducirlo como «borra todo lo vivo e
 * inserta lo nuevo» converge, sí, pero converge en basura en cuanto hay dos
 * autores: los borrados de cada uno solo alcanzan a los átomos que ese autor
 * VIO, así que las dos tiradas de inserción sobreviven enteras y el párrafo
 * aparece DUPLICADO ("holaXholaY"). Y una pulsación cuesta O(n) ops.
 *
 * Con prefijo/sufijo comunes, una pulsación es UNA op sobre UN átomo, que es lo
 * que la spec promete («las pulsaciones producen textInsert/textDelete») y lo
 * único con lo que dos personas pueden teclear en el mismo párrafo a la vez.
 * Los átomos nuevos se anclan ENTRE los supervivientes (`left`/`right` reales,
 * no `right:null`): así una inserción ajena en el mismo hueco se ordena por
 * Fugue en vez de caer siempre al final.
 *
 * Si el HTML no es representable como un único párrafo (listas, multi-bloque),
 * se conserva el camino de reemplazo total + `propSet` verbatim — su HLC es
 * POSTERIOR al de los borrados, así que gana en la proyección.
 */
function emitTextEdit(
  state: CrdtDoc,
  nodeId: string,
  field: string,
  value: unknown,
  out: CollabOp[],
): void {
  const text = state.textField(nodeId, field);
  if (!text) return;
  const positions = text.livePositions();
  const next = atomsOf(value);

  if (!next) {
    for (const pos of [...positions]) {
      out.push({ k: "textDelete", id: state.nextOpId(), nodeId, field, pos, hlc: state.nextHlc() });
    }
    out.push({ k: "propSet", id: state.nextOpId(), nodeId, key: field, value, hlc: state.nextHlc() });
    return;
  }

  // `atoms()` recorre las MISMAS posiciones vivas y en el mismo orden que
  // `livePositions()` (FugueList.entries() se deriva de ella): el índice `i`
  // vale para las dos listas.
  const cur = text.atoms();
  let pre = 0;
  while (pre < cur.length && pre < next.length && sameAtom(cur[pre], next[pre])) pre++;
  let suf = 0;
  while (
    suf < cur.length - pre &&
    suf < next.length - pre &&
    sameAtom(cur[cur.length - 1 - suf], next[next.length - 1 - suf])
  ) {
    suf++;
  }

  const cutEnd = cur.length - suf; // primer átomo del sufijo intacto
  for (let i = pre; i < cutEnd; i++) {
    out.push({ k: "textDelete", id: state.nextOpId(), nodeId, field, pos: positions[i], hlc: state.nextHlc() });
  }
  let left: PosRef | null = pre > 0 ? positions[pre - 1] : null;
  const right: PosRef | null = cutEnd < positions.length ? positions[cutEnd] : null;
  for (let i = pre; i < next.length - suf; i++) {
    const atom = next[i];
    const id = state.nextOpId();
    out.push({
      k: "textInsert",
      id,
      nodeId,
      field,
      left,
      right,
      atom: { br: atom.br, ch: atom.ch, marks: atom.marks },
      hlc: state.nextHlc(),
    });
    left = opIdKey(id);
  }
}

/** Igualdad de átomos a efectos del diff: contenido Y marcas (un negrita ES un cambio). */
function sameAtom(a: Atom, b: Atom): boolean {
  return a.br === b.br && a.ch === b.ch && sameMarks(a.marks, b.marks);
}

/** Átomos de un HTML de un solo párrafo, o null si no es representable. */
export function atomsOf(value: unknown): Atom[] | null {
  if (typeof value !== "string") return null;
  const parsed = parseRichHtml(value);
  if (parsed.blocks.length !== 1 || parsed.blocks[0].kind !== "p") return null;
  return paraToAtoms(parsed.blocks[0].para);
}

/** Remapea `props.id` de todo el subtree con el idMap del emisor (materializado). */
function remapIds(
  item: VersoItem,
  idMap: Record<string, string>,
  gen: () => string,
  isSlot?: SlotResolver,
): VersoItem {
  const oldId = item.props.id;
  const newId = Object.hasOwn(idMap, oldId) ? idMap[oldId] : (idMap[oldId] = gen());
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item.props)) {
    if (k === "id") {
      props.id = newId;
    } else if (classifySlotProp(isSlot?.(item.type, k), v)) {
      setOwn(props, k, (v as VersoItem[]).map((child) => remapIds(child, idMap, gen, isSlot)));
    } else {
      setOwn(props, k, v);
    }
  }
  const out: VersoItem = { type: item.type, props: props as VersoItem["props"] };
  for (const k of Object.keys(item)) {
    if (k !== "type" && k !== "props") (out as unknown as Record<string, unknown>)[k] = (item as unknown as Record<string, unknown>)[k];
  }
  return out;
}

function isInSubtree(doc: VersoDoc, nodeId: string, candidateParent: string): boolean {
  let cur = candidateParent;
  const seen = new Set<string>();
  while (cur !== ROOT_ID) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    const n = Object.hasOwn(doc.nodes, cur) ? doc.nodes[cur] : undefined;
    if (!n) return false;
    cur = n.parentId;
  }
  return false;
}

function isItem(value: unknown): value is VersoItem {
  if (!isPlainObject(value)) return false;
  const props = (value as { props?: unknown }).props;
  return (
    typeof (value as { type?: unknown }).type === "string" &&
    isPlainObject(props) &&
    typeof (props as { id?: unknown }).id === "string"
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** FNV-1a sobre el JSON: identifica el snapshot de un `docReset` sin criptografía. */
export function hashJson(value: unknown): string {
  const s = JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
