/**
 * Verso — aplicación de comandos sobre el documento normalizado.
 *
 * CONTRATO (F2, ver documentation/verso/f0-audit-core.md):
 * - `applyCommand(doc, cmd)` es PURO e INMUTABLE con estructura compartida:
 *   jamás muta el doc de entrada; copia solo los nodos/arrays afectados.
 * - Cada comando devuelve su INVERSO EXACTO: aplicar `inverse` sobre el doc
 *   resultante produce un documento cuya SERIALIZACIÓN (`fromNormalized`) es
 *   deep-equal a la del doc de entrada (propiedad testeada con secuencias
 *   aleatorias en verso-commands.test.ts).
 * - Comando inválido → throw `VersoCommandError` SIN tocar el doc. Un índice
 *   fuera de rango NO es inválido: se clampa (y el comando efectivo devuelto
 *   en `command` lleva el índice clampado, para que redo sea determinista).
 */

import {
  ROOT_ID,
  ROOT_SLOT,
  type DuplicateSubtreeCommand,
  type InsertNodeCommand,
  type MoveNodeCommand,
  type RemoveNodeCommand,
  type ReplaceDataCommand,
  type RestoreDocCommand,
  type SetPropsCommand,
  type SetRootPropsCommand,
  type SlotResolver,
  type VersoDoc,
  type VersoHistoryCommand,
  type VersoItem,
  type VersoNode,
} from "./types";
import { classifySlotProp, emitNodeProps, isVersoItem, toNormalized } from "./normalize";

export type VersoCommandErrorCode =
  | "bad-command"
  | "node-not-found"
  | "parent-not-found"
  | "slot-not-insertable"
  | "cycle"
  | "immutable-id"
  | "slot-prop-conflict"
  | "transaction-sealed";

/** Error tipado de comando inválido. El doc de entrada queda intacto SIEMPRE. */
export class VersoCommandError extends Error {
  readonly code: VersoCommandErrorCode;
  constructor(code: VersoCommandErrorCode, message: string) {
    super(message);
    this.name = "VersoCommandError";
    this.code = code;
  }
}

export interface ApplyCommandOptions {
  /** Mismo resolutor que usa `toNormalized` — debe ser consistente en todo el editor. */
  isSlot?: SlotResolver;
  /** Ids frescos para `duplicateSubtree` cuando `idMap` no cubre todo el subtree. */
  generateId?: () => string;
}

export interface ApplyCommandResult {
  doc: VersoDoc;
  /** Inverso exacto del comando aplicado (puede ser el interno `history:restoreDoc`). */
  inverse: VersoHistoryCommand;
  /**
   * Comando EFECTIVO: índices clampados e `idMap` materializado. Es lo que la
   * historia debe almacenar — re-aplicarlo (redo) reproduce el mismo resultado.
   */
  command: VersoHistoryCommand;
}

let fallbackIdCounter = 0;
function defaultGenerateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  fallbackIdCounter += 1;
  return `verso-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* Draft: copia perezosa con estructura compartida.                    */
/* ------------------------------------------------------------------ */

interface Draft {
  next: VersoDoc;
  /** Claves de nodo ya copiadas en este draft (mutables sin riesgo). */
  touched: Set<string>;
}

function beginDraft(doc: VersoDoc): Draft {
  return { next: { ...doc, nodes: { ...doc.nodes } }, touched: new Set() };
}

/**
 * Lookup SIN cadena de prototipos (F6, cazado por el fuzzer): un id hostil
 * "constructor"/"hasOwnProperty" resolvía a Function/función por prototipo y el
 * llamador lo trataba como VersoNode. Toda búsqueda por clave externa pasa por aquí.
 */
function nodeOf(nodes: Record<string, VersoNode>, key: string): VersoNode | undefined {
  return Object.hasOwn(nodes, key) ? nodes[key] : undefined;
}

/** Devuelve una copia mutable del nodo dentro del draft (copia una sola vez). */
function draftNode(d: Draft, key: string): VersoNode {
  const current = nodeOf(d.next.nodes, key);
  if (!current) throw new VersoCommandError("node-not-found", `nodo "${key}" inexistente`);
  if (d.touched.has(key)) return current;
  const copy: VersoNode = { ...current, slots: { ...current.slots } };
  d.next.nodes[key] = copy;
  d.touched.add(key);
  return copy;
}

function readChildren(doc: VersoDoc, parentId: string, slotKey: string): readonly string[] | undefined {
  if (parentId === ROOT_ID) return slotKey === ROOT_SLOT ? doc.rootChildren : undefined;
  const slots = nodeOf(doc.nodes, parentId)?.slots;
  if (!slots) return undefined;
  return Object.hasOwn(slots, slotKey) ? slots[slotKey] : undefined;
}

/**
 * Escribe la lista de hijos de (parentId, slotKey) y recalcula index/parentId/
 * slotKey de cada hermano afectado — copiando SOLO los nodos cuyo valor cambia.
 */
function writeChildren(d: Draft, parentId: string, slotKey: string, list: string[]): void {
  if (parentId === ROOT_ID) {
    d.next.rootChildren = list;
  } else {
    draftNode(d, parentId).slots[slotKey] = list;
  }
  for (let i = 0; i < list.length; i++) {
    const child = d.next.nodes[list[i]];
    if (!child) continue;
    if (child.index !== i || child.parentId !== parentId || child.slotKey !== slotKey) {
      const copy = draftNode(d, list[i]);
      copy.index = i;
      copy.parentId = parentId;
      copy.slotKey = slotKey;
    }
  }
}

/**
 * Resuelve el destino de una inserción, consultando el registry vía `isSlot`:
 * - declarado NO-slot (`false`) → `slot-not-insertable` SIEMPRE, aunque el valor
 *   en runtime sea `[]` (un field `array` no se re-clasifica por su forma).
 * - declarado slot (`true`) → insertable incluso si la clave no existe aún o vive
 *   en props como `[]`: el slot se crea/promociona.
 * - sin opinión (`undefined`) → detección estructural: un array VACÍO en props se
 *   promociona a slot (la serialización es idéntica — clave → [] — así que el
 *   inverso sigue siendo exacto); cualquier otra cosa no es insertable.
 */
interface InsertTarget {
  list: readonly string[];
  /**
   * true si la CLAVE del slot no existía y se acaba de materializar (declarado
   * slot por el registry, clave ausente). EXACTITUD DE INVERSOS (F6, cazado por
   * el fuzzer): deshacer el insert/move con removeNode/moveNode dejaba un
   * `clave: []` residual y la serialización ya no era deep-equal a la de
   * partida — en ese caso el inverso exacto es restaurar el doc entero
   * (history:restoreDoc, el mismo mecanismo que setRootProps sin props).
   */
  createdSlotKey: boolean;
}

function resolveInsertTarget(
  d: Draft,
  parentId: string,
  slotKey: string,
  isSlot?: SlotResolver,
): InsertTarget {
  if (parentId === ROOT_ID) {
    if (slotKey !== ROOT_SLOT) {
      throw new VersoCommandError("slot-not-insertable", `la raíz solo tiene el slot "${ROOT_SLOT}"`);
    }
    return { list: d.next.rootChildren, createdSlotKey: false };
  }
  const parent = nodeOf(d.next.nodes, parentId);
  if (!parent) throw new VersoCommandError("parent-not-found", `padre "${parentId}" inexistente`);
  const declared = isSlot?.(parent.type, slotKey);
  if (declared === false) {
    throw new VersoCommandError(
      "slot-not-insertable",
      `"${parentId}.${slotKey}" está declarado NO-slot por el registry`,
    );
  }
  // Object.hasOwn, no lookup directo/`in` (F6): un slotKey "constructor" resolvía
  // por prototipo (Function como "slot", Object.prototype como "prop presente").
  const slot = Object.hasOwn(parent.slots, slotKey) ? parent.slots[slotKey] : undefined;
  if (slot) return { list: slot, createdSlotKey: false };
  const hasProp = Object.hasOwn(parent.props, slotKey);
  const asProp = hasProp ? parent.props[slotKey] : undefined;
  if (declared === true) {
    // Con un resolutor consistente (contrato de ApplyCommandOptions.isSlot) un
    // valor slot-shaped no vacío ya estaría en `slots`; aquí solo puede quedar
    // una clave ausente, un [] en props, o un valor no-slot que NO se pisa.
    if (hasProp && (!classifySlotProp(declared, asProp) || (asProp as unknown[]).length > 0)) {
      throw new VersoCommandError(
        "slot-not-insertable",
        `"${parentId}.${slotKey}" está declarado slot pero la clave contiene un valor no promovible`,
      );
    }
  } else if (!(hasProp && Array.isArray(asProp) && asProp.length === 0)) {
    throw new VersoCommandError("slot-not-insertable", `"${parentId}.${slotKey}" no es un slot insertable`);
  }
  const copy = draftNode(d, parentId);
  if (hasProp) {
    // Preservar la posición original de la clave promovida en la serialización.
    if (!copy.keyOrder) copy.keyOrder = Object.keys(copy.props);
    copy.props = { ...copy.props };
    delete copy.props[slotKey];
  }
  copy.slots[slotKey] = [];
  // Promoción de un [] en props: la serialización no cambia (clave → []), el
  // inverso clave-a-clave sigue siendo exacto. Clave AUSENTE materializada:
  // el llamador debe emitir history:restoreDoc como inverso (ver InsertTarget).
  return { list: copy.slots[slotKey], createdSlotKey: !hasProp };
}

function clampIndex(index: number, length: number): number {
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.max(0, Math.min(i, length));
}

/**
 * Interna un VersoItem (con sus slots anidados) como nodos del draft. Espejo
 * de `normalizeItem` de normalize.ts, incluida la desambiguación `#dupN` de
 * ids en colisión (dato corrupto preexistente — fail-soft, jamás throw).
 */
function internItem(
  d: Draft,
  item: VersoItem,
  parentId: string,
  slotKey: string,
  index: number,
  isSlot?: SlotResolver,
): string {
  const originalId = item.props.id;
  let key = originalId;
  // Object.hasOwn, no `in` (F6): espejo del fix de internKey en normalize.ts —
  // incluida la colisión con ROOT_ID (props.id "verso:root" hostil).
  if (key === ROOT_ID || Object.hasOwn(d.next.nodes, key)) {
    let n = 2;
    while (Object.hasOwn(d.next.nodes, `${originalId}#dup${n}`)) n += 1;
    key = `${originalId}#dup${n}`;
  }
  // Espejo de normalizeItem: props en el ORDEN ORIGINAL de claves (id incluido en
  // su posición) — forzar id-primero reordenaba el JSON persistido (gate F4).
  const props = {} as VersoNode["props"];
  const slots: Record<string, string[]> = {};
  const node: VersoNode = { id: key, type: item.type, props, slots, parentId, slotKey, index };
  for (const k of Object.keys(item)) {
    if (k !== "type" && k !== "props") {
      (node.extras ??= {})[k] = (item as unknown as Record<string, unknown>)[k];
    }
  }
  d.next.nodes[key] = node;
  d.touched.add(key);
  for (const [k, v] of Object.entries(item.props)) {
    if (k === "id") {
      (props as Record<string, unknown>).id = originalId;
      continue;
    }
    if (classifySlotProp(isSlot?.(item.type, k), v)) {
      slots[k] = (v as VersoItem[]).map((child, i) => internItem(d, child, key, k, i, isSlot));
    } else {
      props[k] = v;
    }
  }
  if (!("id" in props)) (props as Record<string, unknown>).id = originalId;
  // Espejo de normalizeItem: el orden original solo se materializa con ≥1 slot.
  if (Object.keys(slots).length > 0) node.keyOrder = Object.keys(item.props);
  return key;
}

/** Serializa el subtree de un nodo como VersoItem (espejo de buildItem, mismo keyOrder). */
export function subtreeToItem(doc: VersoDoc, key: string): VersoItem {
  const node = nodeOf(doc.nodes, key);
  if (!node) throw new VersoCommandError("node-not-found", `nodo "${key}" inexistente`);
  const props = emitNodeProps(node, (c) => subtreeToItem(doc, c));
  const item: VersoItem = { type: node.type, props };
  if (node.extras) Object.assign(item as unknown as Record<string, unknown>, node.extras);
  return item;
}

function collectSubtreeKeys(doc: VersoDoc, key: string, out: string[] = []): string[] {
  out.push(key);
  const node = nodeOf(doc.nodes, key);
  if (node) {
    for (const children of Object.values(node.slots)) {
      for (const c of children) collectSubtreeKeys(doc, c, out);
    }
  }
  return out;
}

/** Rechaza mover un nodo dentro de su propio subtree (incluido él mismo). */
function assertNotInSubtree(doc: VersoDoc, nodeKey: string, candidateParent: string): void {
  let cur = candidateParent;
  const seen = new Set<string>();
  while (cur !== ROOT_ID) {
    if (cur === nodeKey) {
      throw new VersoCommandError("cycle", `no se puede mover "${nodeKey}" dentro de su propio subtree`);
    }
    if (seen.has(cur)) break; // ciclo corrupto preexistente: no bloquear aquí
    seen.add(cur);
    const n = nodeOf(doc.nodes, cur);
    if (!n) break;
    cur = n.parentId;
  }
}

function assertPlainPatch(patch: unknown, kind: string): asserts patch is Record<string, unknown> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new VersoCommandError("bad-command", `${kind}.patch debe ser un objeto plano`);
  }
}

/* ------------------------------------------------------------------ */
/* Comandos                                                            */
/* ------------------------------------------------------------------ */

function applyInsert(doc: VersoDoc, cmd: InsertNodeCommand, opts: ApplyCommandOptions): ApplyCommandResult {
  if (!isVersoItem(cmd.item)) {
    throw new VersoCommandError("bad-command", "insertNode.item no es un VersoItem válido");
  }
  const d = beginDraft(doc);
  const target = resolveInsertTarget(d, cmd.parentId, cmd.slotKey, opts.isSlot);
  const index = clampIndex(cmd.index, target.list.length);
  const key = internItem(d, cmd.item, cmd.parentId, cmd.slotKey, index, opts.isSlot);
  const list = [...target.list];
  list.splice(index, 0, key);
  writeChildren(d, cmd.parentId, cmd.slotKey, list);
  return {
    doc: d.next,
    // Slot materializado desde clave ausente: removeNode dejaría `clave: []`
    // residual — el inverso exacto es restaurar el doc previo (ver InsertTarget).
    inverse: target.createdSlotKey ? { kind: "history:restoreDoc", doc } : { kind: "removeNode", nodeId: key },
    command: index === cmd.index ? cmd : { ...cmd, index },
  };
}

function applyRemove(doc: VersoDoc, cmd: RemoveNodeCommand): ApplyCommandResult {
  const node = nodeOf(doc.nodes, cmd.nodeId);
  if (!node) throw new VersoCommandError("node-not-found", `removeNode: nodo "${cmd.nodeId}" inexistente`);
  // El inverso captura el SUBTREE entero (nodo + slots recursivos) y su posición.
  const item = subtreeToItem(doc, cmd.nodeId);
  const siblings = readChildren(doc, node.parentId, node.slotKey) ?? [];
  const pos = siblings.indexOf(cmd.nodeId);
  const inverse: InsertNodeCommand = {
    kind: "insertNode",
    item,
    parentId: node.parentId,
    slotKey: node.slotKey,
    index: pos >= 0 ? pos : node.index,
  };
  const d = beginDraft(doc);
  writeChildren(
    d,
    node.parentId,
    node.slotKey,
    siblings.filter((k) => k !== cmd.nodeId),
  );
  for (const k of collectSubtreeKeys(doc, cmd.nodeId)) delete d.next.nodes[k];
  return { doc: d.next, inverse, command: cmd };
}

function applyMove(doc: VersoDoc, cmd: MoveNodeCommand, opts: ApplyCommandOptions): ApplyCommandResult {
  const node = nodeOf(doc.nodes, cmd.nodeId);
  if (!node) throw new VersoCommandError("node-not-found", `moveNode: nodo "${cmd.nodeId}" inexistente`);
  if (cmd.toParentId !== ROOT_ID) {
    if (!nodeOf(doc.nodes, cmd.toParentId)) {
      throw new VersoCommandError("parent-not-found", `moveNode: padre "${cmd.toParentId}" inexistente`);
    }
    assertNotInSubtree(doc, cmd.nodeId, cmd.toParentId);
  }
  const fromSiblings = readChildren(doc, node.parentId, node.slotKey) ?? [];
  const fromIndex = fromSiblings.indexOf(cmd.nodeId);
  const inverse: MoveNodeCommand = {
    kind: "moveNode",
    nodeId: cmd.nodeId,
    toParentId: node.parentId,
    toSlotKey: node.slotKey,
    toIndex: fromIndex >= 0 ? fromIndex : node.index,
  };
  const d = beginDraft(doc);
  // Extraer del origen primero: el índice de destino es post-remoción (así el
  // inverso, que usa el índice de origen pre-remoción, restaura exactamente).
  writeChildren(
    d,
    node.parentId,
    node.slotKey,
    fromSiblings.filter((k) => k !== cmd.nodeId),
  );
  const target = resolveInsertTarget(d, cmd.toParentId, cmd.toSlotKey, opts.isSlot);
  const toIndex = clampIndex(cmd.toIndex, target.list.length);
  const list = [...target.list];
  list.splice(toIndex, 0, cmd.nodeId);
  writeChildren(d, cmd.toParentId, cmd.toSlotKey, list);
  return {
    doc: d.next,
    // Mismo caso que applyInsert: mover HACIA un slot materializado desde clave
    // ausente dejaría `clave: []` residual al deshacer — restoreDoc es el exacto.
    inverse: target.createdSlotKey ? { kind: "history:restoreDoc", doc } : inverse,
    command: toIndex === cmd.toIndex ? cmd : { ...cmd, toIndex },
  };
}

function applySetProps(doc: VersoDoc, cmd: SetPropsCommand): ApplyCommandResult {
  const node = nodeOf(doc.nodes, cmd.nodeId);
  if (!node) throw new VersoCommandError("node-not-found", `setProps: nodo "${cmd.nodeId}" inexistente`);
  assertPlainPatch(cmd.patch, "setProps");
  if (Object.hasOwn(cmd.patch, "id")) throw new VersoCommandError("immutable-id", "setProps: `id` es inmutable");
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(cmd.patch)) {
    // Object.hasOwn, no `in` (F6): un patch con clave "constructor" disparaba
    // slot-prop-conflict por la cadena de prototipos sin haber tal slot.
    if (Object.hasOwn(node.slots, k)) {
      throw new VersoCommandError("slot-prop-conflict", `setProps: "${k}" es un slot de "${cmd.nodeId}"`);
    }
    // `undefined` = clave ausente: el inverso la eliminará con undefined.
    // Object.hasOwn (F6): con k="constructor", `node.props[k]` devolvía la Function
    // del prototipo y el INVERSO estampaba esa Function como prop propia.
    prev[k] = Object.hasOwn(node.props, k) ? node.props[k] : undefined;
  }
  const d = beginDraft(doc);
  const copy = draftNode(d, cmd.nodeId);
  const props = { ...copy.props };
  for (const [k, v] of Object.entries(cmd.patch)) {
    if (v === undefined) delete props[k];
    else props[k] = v;
  }
  copy.props = props as VersoNode["props"];
  return {
    doc: d.next,
    inverse: { kind: "setProps", nodeId: cmd.nodeId, patch: prev },
    command: cmd,
  };
}

function applySetRootProps(doc: VersoDoc, cmd: SetRootPropsCommand): ApplyCommandResult {
  assertPlainPatch(cmd.patch, "setRootProps");
  const currentProps = doc.root.props;
  const propsIsPlain =
    typeof currentProps === "object" && currentProps !== null && !Array.isArray(currentProps);
  let inverse: VersoHistoryCommand;
  if (propsIsPlain) {
    const prev: Record<string, unknown> = {};
    for (const k of Object.keys(cmd.patch)) prev[k] = (currentProps as Record<string, unknown>)[k];
    inverse = { kind: "setRootProps", patch: prev };
  } else {
    // root sin `props`: el forward materializa `props: {}` y eso no es
    // invertible clave-a-clave — el inverso exacto es restaurar el doc entero.
    inverse = { kind: "history:restoreDoc", doc };
  }
  const base: Record<string, unknown> = propsIsPlain ? { ...(currentProps as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(cmd.patch)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return {
    doc: { ...doc, root: { ...doc.root, props: base } },
    inverse,
    command: cmd,
  };
}

/** Reconstruye el subtree como item con TODOS los props.id remapeados a ids frescos. */
function duplicateItemFromNode(
  doc: VersoDoc,
  key: string,
  idMap: Record<string, string>,
  gen: () => string,
): VersoItem {
  const node = nodeOf(doc.nodes, key);
  if (!node) throw new VersoCommandError("node-not-found", `duplicateSubtree: nodo "${key}" inexistente`);
  const oldId = node.props.id;
  // Object.hasOwn (F6): con oldId "constructor", `idMap[oldId] ??` devolvía la
  // Function del prototipo como "id nuevo" y corrompía el duplicado.
  const newId = Object.hasOwn(idMap, oldId) ? idMap[oldId] : (idMap[oldId] = gen());
  const props = emitNodeProps(node, (c) => duplicateItemFromNode(doc, c, idMap, gen));
  props.id = newId; // re-asignar no mueve la clave: conserva su posición original
  const item: VersoItem = { type: node.type, props };
  if (node.extras) Object.assign(item as unknown as Record<string, unknown>, node.extras);
  return item;
}

function applyDuplicate(doc: VersoDoc, cmd: DuplicateSubtreeCommand, opts: ApplyCommandOptions): ApplyCommandResult {
  const node = nodeOf(doc.nodes, cmd.nodeId);
  if (!node) throw new VersoCommandError("node-not-found", `duplicateSubtree: nodo "${cmd.nodeId}" inexistente`);
  const gen = opts.generateId ?? defaultGenerateId;
  const idMap: Record<string, string> = { ...(cmd.idMap ?? {}) };
  const item = duplicateItemFromNode(doc, cmd.nodeId, idMap, gen);
  const siblings = readChildren(doc, node.parentId, node.slotKey) ?? [];
  const pos = siblings.indexOf(cmd.nodeId);
  const insertAt = (pos >= 0 ? pos : node.index) + 1;
  const d = beginDraft(doc);
  const key = internItem(d, item, node.parentId, node.slotKey, insertAt, opts.isSlot);
  const list = [...siblings];
  list.splice(insertAt, 0, key);
  writeChildren(d, node.parentId, node.slotKey, list);
  return {
    doc: d.next,
    inverse: { kind: "removeNode", nodeId: key },
    // idMap materializado: redo reproduce EXACTAMENTE los mismos ids.
    command: { ...cmd, idMap },
  };
}

function applyReplace(doc: VersoDoc, cmd: ReplaceDataCommand, opts: ApplyCommandOptions): ApplyCommandResult {
  if (typeof cmd.data !== "object" || cmd.data === null || Array.isArray(cmd.data)) {
    throw new VersoCommandError("bad-command", "replaceData.data debe ser un objeto VersoData");
  }
  // El inverso restaura el doc previo VERBATIM (history:restoreDoc): re-normalizar
  // una serialización perdería metadatos de forma (p.ej. contentKeyState "absent"
  // → "array"), rompiendo la exactitud de inversos posteriores en un rollback.
  const inverse: RestoreDocCommand = { kind: "history:restoreDoc", doc };
  return { doc: toNormalized(cmd.data, opts.isSlot), inverse, command: cmd };
}

/** Comando interno de historia: publica `cmd.doc` verbatim; su inverso es el doc previo. */
function applyRestoreDoc(doc: VersoDoc, cmd: RestoreDocCommand): ApplyCommandResult {
  return { doc: cmd.doc, inverse: { kind: "history:restoreDoc", doc }, command: cmd };
}

export function applyCommand(
  doc: VersoDoc,
  cmd: VersoHistoryCommand,
  opts: ApplyCommandOptions = {},
): ApplyCommandResult {
  switch (cmd.kind) {
    case "insertNode":
      return applyInsert(doc, cmd, opts);
    case "removeNode":
      return applyRemove(doc, cmd);
    case "moveNode":
      return applyMove(doc, cmd, opts);
    case "setProps":
      return applySetProps(doc, cmd);
    case "setRootProps":
      return applySetRootProps(doc, cmd);
    case "duplicateSubtree":
      return applyDuplicate(doc, cmd, opts);
    case "replaceData":
      return applyReplace(doc, cmd, opts);
    case "history:restoreDoc":
      return applyRestoreDoc(doc, cmd);
    default: {
      const kind = (cmd as { kind?: unknown }).kind;
      throw new VersoCommandError("bad-command", `comando desconocido: ${String(kind)}`);
    }
  }
}
