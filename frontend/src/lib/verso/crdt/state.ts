/**
 * Verso CRDT — estado replicado del documento y proyección a `VersoDoc`.
 *
 * Contrato (documentation/verso/crdt-spec.md):
 * - §1.2 listas de slots con `FugueList` (bloques) — §1.4 texto por átomos.
 * - §1.3 props con LWW por CLAVE + HLC (D3).
 * - §3.2.1 `listMove` es PRIMITIVA (D10): un nodo tiene exactamente UNA
 *   posición viva; los moves viven en un log ordenado por HLC con la
 *   disciplina *undo → apply → redo* de Kleppmann (verificada en Isabelle/HOL),
 *   que aquí se materializa como REPLAY del log — misma semántica, mucho más
 *   fácil de auditar — con vía rápida cuando el move llega en orden.
 * - §3.2.2 el borrado NO es recursivo: los descendientes siguen vivos pero
 *   inalcanzables, así un hijo que otro sacó del subtree concurrentemente
 *   sobrevive en su nuevo padre.
 * - §3.4 (D12) EL INVARIANTE: el CRDT replica también los metadatos de FORMA
 *   (`topKeyOrder`, `contentKeyState`, `extras`, `keyOrder`, `orphanZones`…),
 *   sin los cuales el primer guardado colaborativo ensuciaría `_puck_data`.
 *
 * DESVIACIÓN DECLARADA respecto a D8 (y el motivo): la spec propone usar
 * `props.id` como identidad y rebautizar en caso de colisión concurrente. Ese
 * rebautizado NO converge (depende de qué `nodeCreate` llegue primero, y
 * re-etiquetar a posteriori dejaría las ops ya integradas apuntando al nodo
 * equivocado). Aquí la identidad interna de un nodo creado por una op es su
 * causal dot (`site@counter`) — único por construcción, imposible de colisionar
 * — y `props.id` sigue siendo un dato normal que se serializa verbatim. Es
 * exactamente la distinción que `normalize.ts` ya hace con sus claves `#dupN`:
 * clave interna ≠ `props.id`. La intención de D8 (identidad estable que
 * sobrevive a los moves) se conserva íntegra.
 */

import {
  ROOT_ID,
  ROOT_SLOT,
  type VersoDoc,
  type VersoItem,
  type VersoNode,
} from "../types";
import { FugueList } from "./fugue";
import {
  bumpVersionVector,
  compareStamp,
  HlcClock,
  isRealSiteId,
  opIdKey,
  SEED_SITE,
  type Hlc,
  type OpId,
  type Stamp,
  type PosRef,
  type SiteId,
  type VersionVector,
} from "./identity";
import { LwwMap } from "./lww";
import { setOwn } from "./objects";
import { TextField } from "./text";
import type {
  ApplyResult,
  CollabOp,
  ListMoveOp,
  RejectionCode,
  RichTextResolver,
  ShapeKey,
} from "./types";

interface NodePosition {
  parentId: string;
  slotKey: string;
  pos: PosRef;
}

interface CrdtNode {
  nodeId: string;
  type: string;
  props: LwwMap;
  keyOrder?: string[];
  extras?: Record<string, unknown>;
  slots: Map<string, FugueList<string>>;
  baseSlotOrder: string[];
  slotCreated: Map<string, Stamp>;
  text: Map<string, TextField>;
  deleted: boolean;
  /** Posición de la inserción original (§3.2.1: la base sobre la que replayan los moves). */
  basePos: NodePosition | null;
  /** Posición VIVA (base o el último move aplicado). */
  pos: NodePosition | null;
}

interface MoveEntry {
  op: ListMoveOp;
  pos: PosRef;
  applied: boolean;
}

export interface CrdtDocOptions {
  /** Identidad de esta réplica (§2.1). Solo se usa para EMITIR. */
  site?: SiteId;
  now?: () => number;
  /** Qué props son texto rico (debe ser el mismo resolutor en toda la sala). */
  isRichText?: RichTextResolver;
  /** Tope del buffer causal: sin tope es un vector de agotamiento de memoria. */
  maxPending?: number;
}

const DEFAULT_MAX_PENDING = 4096;

/** Sello mínimo: pierde contra cualquier op real, gana contra el valor base. */
const ZERO_STAMP: Stamp = { hlc: { l: 0, c: 0, site: "" }, tie: "" };

const stampOf = (op: { id: OpId; hlc: Hlc }): Stamp => ({ hlc: op.hlc, tie: opIdKey(op.id) });

/** Estado replicado de un documento. Mutable a propósito: la proyección es la inmutable. */
export class CrdtDoc {
  readonly site: SiteId;
  readonly clock: HlcClock;
  readonly vv: VersionVector = {};
  epoch = 1;

  private readonly isRichText: RichTextResolver;
  private readonly maxPending: number;
  private readonly nodes = new Map<string, CrdtNode>();
  private readonly rootExtras: LwwMap;
  private readonly shape: LwwMap;
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, CollabOp[]>();
  private readonly moveLog: MoveEntry[] = [];
  private readonly baseWarnings: string[];
  private readonly runtimeWarnings: string[] = [];
  private rootPropsPresent: boolean;
  private counter = 0;
  private pendingCount = 0;

  private constructor(doc: VersoDoc, opts: CrdtDocOptions) {
    this.site = opts.site ?? "s_local";
    this.clock = new HlcClock(this.site, opts.now);
    this.isRichText = opts.isRichText ?? (() => false);
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.baseWarnings = [...doc.warnings];

    const rootProps = doc.root.props;
    const rootPropsPlain = typeof rootProps === "object" && rootProps !== null && !Array.isArray(rootProps);
    this.rootPropsPresent = rootPropsPlain;

    const rootExtrasBase: Record<string, unknown> = {};
    const rootExtrasOrder: string[] = [];
    for (const k of Object.keys(doc.root)) {
      if (k === "props" && rootPropsPlain) continue;
      rootExtrasBase[k] = (doc.root as Record<string, unknown>)[k];
      rootExtrasOrder.push(k);
    }
    this.rootExtras = new LwwMap(rootExtrasBase, rootExtrasOrder);

    const shapeBase: Record<string, unknown> = {
      topKeyOrder: [...doc.topKeyOrder],
      contentKeyState: doc.contentKeyState,
      rootKeyPresent: doc.rootKeyPresent,
      zonesKeyPresent: doc.zonesKeyPresent,
      rootKeyOrder: Object.keys(doc.root),
    };
    for (const [k, v] of Object.entries(doc.extras)) shapeBase[`extras:${k}`] = v;
    for (const [k, v] of Object.entries(doc.orphanZones)) shapeBase[`orphanZones:${k}`] = v;
    this.shape = new LwwMap(shapeBase);

    // Raíz como pseudo-nodo: unifica el camino de propSet/listInsert.
    const root: CrdtNode = {
      nodeId: ROOT_ID,
      type: "",
      props: new LwwMap(rootPropsPlain ? (rootProps as Record<string, unknown>) : {}),
      slots: new Map([[ROOT_SLOT, new FugueList<string>()]]),
      baseSlotOrder: [ROOT_SLOT],
      slotCreated: new Map(),
      text: new Map(),
      deleted: false,
      basePos: null,
      pos: null,
    };
    this.nodes.set(ROOT_ID, root);

    // Posiciones SEMILLA: derivadas del snapshot en orden DFS, iguales en todas
    // las réplicas sin coordinación (§ text.ts, mismo principio).
    const seed = { counter: 0 };
    this.seedSlot(doc, root, ROOT_SLOT, doc.rootChildren, seed);
  }

  /** Convierte un documento normalizado en estado CRDT (gate G-F8.1-c). */
  static fromDoc(doc: VersoDoc, opts: CrdtDocOptions = {}): CrdtDoc {
    return new CrdtDoc(doc, opts);
  }

  private seedSlot(
    doc: VersoDoc,
    parent: CrdtNode,
    slotKey: string,
    childIds: readonly string[],
    seed: { counter: number },
  ): void {
    const list = parent.slots.get(slotKey)!;
    let left: PosRef | null = null;
    for (const childId of childIds) {
      const source = Object.hasOwn(doc.nodes, childId) ? doc.nodes[childId] : undefined;
      if (!source) continue;
      seed.counter += 1;
      const id: OpId = { site: SEED_SITE, counter: seed.counter };
      const pos = opIdKey(id);
      list.integrate(id, left, null, childId);
      left = pos;
      this.seedNode(doc, source, { parentId: parent.nodeId, slotKey, pos }, seed);
    }
  }

  private seedNode(doc: VersoDoc, source: VersoNode, position: NodePosition, seed: { counter: number }): void {
    const props = new LwwMap(source.props, Object.keys(source.props));
    const node: CrdtNode = {
      nodeId: source.id,
      type: source.type,
      props,
      keyOrder: source.keyOrder ? [...source.keyOrder] : undefined,
      extras: source.extras ? { ...source.extras } : undefined,
      slots: new Map(),
      baseSlotOrder: Object.keys(source.slots),
      slotCreated: new Map(),
      text: new Map(),
      deleted: false,
      basePos: position,
      pos: position,
    };
    this.nodes.set(source.id, node);
    for (const key of node.baseSlotOrder) node.slots.set(key, new FugueList<string>());
    for (const key of Object.keys(source.props)) {
      if (key === "id" || !this.isRichText(source.type, key)) continue;
      const field = TextField.open(source.id, key, source.props[key]);
      if (field) node.text.set(key, field);
    }
    for (const key of node.baseSlotOrder) this.seedSlot(doc, node, key, source.slots[key], seed);
  }

  /* ---------------------------------------------------------------- */
  /* Emisión (el bridge la usa; la red es fase C)                      */
  /* ---------------------------------------------------------------- */

  nextOpId(): OpId {
    this.counter += 1;
    return { site: this.site, counter: this.counter };
  }

  nextHlc(): Hlc {
    return this.clock.send();
  }

  /* ---------------------------------------------------------------- */
  /* Lecturas que necesita el bridge                                   */
  /* ---------------------------------------------------------------- */

  hasNode(nodeId: string): boolean {
    const n = this.nodes.get(nodeId);
    return !!n && !n.deleted;
  }

  nodeType(nodeId: string): string | null {
    return this.nodes.get(nodeId)?.type ?? null;
  }

  nodePosition(nodeId: string): NodePosition | null {
    return this.nodes.get(nodeId)?.pos ?? null;
  }

  /**
   * Vecinos para insertar en el índice `index` de `(parentId, slotKey)`.
   *
   * OJO — esto tiene que mirar las posiciones VISIBLES en la proyección, no las
   * "vivas" de la lista Fugue: un nodo borrado o que se movió a otro padre deja
   * su posición en la lista (la necesitan como origen las ops concurrentes y el
   * replay de moves), pero YA NO se pinta. Contar esas posiciones desplazaba el
   * índice y el bloque aterrizaba en otro hueco que en `applyCommand` — cazado
   * por el gate de equivalencia del puente.
   */
  neighborsForIndex(
    parentId: string,
    slotKey: string,
    index: number,
    excludeNodeId?: string,
  ): { left: PosRef | null; right: PosRef | null } {
    const visible = this.visiblePositions(parentId, slotKey, excludeNodeId);
    const i = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : 0, visible.length));
    return { left: i > 0 ? visible[i - 1] : null, right: i < visible.length ? visible[i] : null };
  }

  /** Igual que `neighborsForIndex` excluyendo el nodo que se está moviendo. */
  neighborsForMove(
    parentId: string,
    slotKey: string,
    index: number,
    excludeNodeId: string,
  ): { left: PosRef | null; right: PosRef | null } {
    return this.neighborsForIndex(parentId, slotKey, index, excludeNodeId);
  }

  private visiblePositions(parentId: string, slotKey: string, excludeNodeId?: string): PosRef[] {
    const list = this.nodes.get(parentId)?.slots.get(slotKey);
    if (!list) return [];
    const out: PosRef[] = [];
    for (const pos of list.livePositions()) {
      const id = list.valueAt(pos);
      if (id === undefined || id === excludeNodeId) continue;
      if (!this.isLiveAt(id, pos)) continue;
      out.push(pos);
    }
    return out;
  }

  textField(nodeId: string, field: string): TextField | null {
    return this.nodes.get(nodeId)?.text.get(field) ?? null;
  }

  isRichTextField(type: string, key: string): boolean {
    return this.isRichText(type, key);
  }

  /* ---------------------------------------------------------------- */
  /* Aplicación de operaciones                                         */
  /* ---------------------------------------------------------------- */

  applyAll(ops: readonly CollabOp[]): ApplyResult[] {
    return ops.map((op) => this.apply(op));
  }

  /**
   * Integra una operación (propia o remota). NUNCA lanza: todo camino de error
   * devuelve un `ApplyResult` tipado (invariante del fuzzing G-F8.6-a).
   */
  apply(op: CollabOp): ApplyResult {
    const guard = this.validate(op);
    if (guard) return guard;
    const key = opIdKey(op.id);
    if (this.seen.has(key)) return { status: "duplicate" };

    const res = this.dispatch(op);
    if (res.status === "applied") {
      this.seen.add(key);
      bumpVersionVector(this.vv, op.id);
      if ("hlc" in op && op.hlc) this.clock.receive(op.hlc);
      this.drain(op);
    } else if (res.status === "buffered" && res.dep) {
      this.buffer(res.dep, op);
    }
    return res;
  }

  /** Validación estructural mínima — la frontera con dato hostil. */
  private validate(op: CollabOp): ApplyResult | null {
    if (typeof op !== "object" || op === null) return { status: "rejected", code: "malformed" };
    const id = (op as CollabOp).id;
    if (!id || typeof id.site !== "string" || !Number.isSafeInteger(id.counter) || id.counter < 0) {
      return { status: "rejected", code: "malformed" };
    }
    // Un cliente no puede firmar posiciones SEMILLA: falsificarlas reordenaría
    // el documento de todas las réplicas (§2.1, el servidor ata siteId↔conexión).
    if (!isRealSiteId(id.site)) return { status: "rejected", code: "forged-seed-site" };
    if (typeof (op as { k?: unknown }).k !== "string") return { status: "rejected", code: "malformed" };
    // Un HLC con NaN/Infinity destruye la TOTALIDAD del orden LWW (NaN no es
    // comparable): dos réplicas ordenarían distinto según el orden de llegada y
    // divergirían. Cazado por el fuzzer adversarial — se rechaza en la puerta.
    const hlc = (op as { hlc?: unknown }).hlc;
    if (hlc !== undefined) {
      const h = hlc as { l?: unknown; c?: unknown; site?: unknown };
      if (!Number.isFinite(h.l) || !Number.isFinite(h.c) || typeof h.site !== "string") {
        return { status: "rejected", code: "malformed" };
      }
    }
    // `__proto__` como clave de slot/prop/campo: el serializador de `normalize`
    // (`emitNodeProps`) hace `bag[k] = v`, que con esa clave NO crea propiedad
    // propia y TIRA el valor en silencio. Como el núcleo no puede tocar el
    // contrato de serialización, la op se rechaza EN LA PUERTA: mejor un
    // rechazo tipado que un bloque que desaparece. Cazado por el fuzzer.
    if (hasProtoKey(op)) return { status: "rejected", code: "malformed" };
    return null;
  }

  private dispatch(op: CollabOp): ApplyResult {
    switch (op.k) {
      case "nodeCreate": {
        if (typeof op.nodeId !== "string" || op.nodeId === "" || typeof op.type !== "string") {
          return { status: "rejected", code: "malformed" };
        }
        if (op.nodeId === ROOT_ID || this.nodes.has(op.nodeId)) {
          return { status: "rejected", code: "slot-conflict" };
        }
        const props = isPlainObject(op.props) ? op.props : {};
        const order = Array.isArray(op.propOrder) ? op.propOrder.filter((k) => typeof k === "string") : Object.keys(props);
        const node: CrdtNode = {
          nodeId: op.nodeId,
          type: op.type,
          props: new LwwMap(props, order),
          keyOrder: Array.isArray(op.keyOrder) ? [...op.keyOrder] : undefined,
          extras: isPlainObject(op.extras) ? { ...op.extras } : undefined,
          slots: new Map(),
          baseSlotOrder: Array.isArray(op.slotKeys) ? op.slotKeys.filter((k) => typeof k === "string") : [],
          slotCreated: new Map(),
          text: new Map(),
          deleted: false,
          basePos: null,
          pos: null,
        };
        for (const k of node.baseSlotOrder) node.slots.set(k, new FugueList<string>());
        for (const k of order) {
          if (k === "id" || !this.isRichText(op.type, k)) continue;
          const field = TextField.open(op.nodeId, k, props[k]);
          if (field) node.text.set(k, field);
        }
        this.nodes.set(op.nodeId, node);
        return { status: "applied" };
      }

      case "listInsert": {
        const node = this.nodes.get(op.nodeId);
        if (!node) return { status: "buffered", dep: `node:${op.nodeId}` };
        const parent = this.nodes.get(op.parentId);
        if (!parent) return { status: "buffered", dep: `node:${op.parentId}` };
        if (typeof op.slotKey !== "string" || op.slotKey === "") return { status: "rejected", code: "malformed" };
        // La raíz SOLO tiene el slot `content` (mismo contrato que
        // `resolveInsertTarget`): sin esta puerta, una op con otro slotKey
        // esconde el nodo en un slot que la serialización no emite — es decir,
        // PÉRDIDA DE CONTENIDO. Cazado por el fuzzer adversarial.
        if (op.parentId === ROOT_ID && op.slotKey !== ROOT_SLOT) {
          return { status: "rejected", code: "slot-conflict" };
        }
        const list = this.ensureSlot(parent, op.slotKey);
        const dep = this.missingOrigin(list, op.left, op.right);
        if (dep) return { status: "buffered", dep: `pos:${op.parentId}:${op.slotKey}:${dep}` };
        const res = list.integrate(op.id, op.left, op.right, op.nodeId);
        if (!res.ok) return { status: "buffered", dep: `pos:${op.parentId}:${op.slotKey}:${res.dep}` };
        const position: NodePosition = { parentId: op.parentId, slotKey: op.slotKey, pos: opIdKey(op.id) };
        if (!node.basePos) {
          node.basePos = position;
          // Un move puede haber llegado ANTES que su inserción (entrega fuera de
          // orden causal): el replay decide qué posición manda, no el orden.
          if (this.moveLog.length > 0) this.replayMoves();
          else node.pos = position;
        }
        return { status: "applied" };
      }

      case "listMove": {
        if (op.nodeId === ROOT_ID) return { status: "rejected", code: "root-not-movable" };
        const node = this.nodes.get(op.nodeId);
        if (!node) return { status: "buffered", dep: `node:${op.nodeId}` };
        const parent = this.nodes.get(op.toParentId);
        if (!parent) return { status: "buffered", dep: `node:${op.toParentId}` };
        if (typeof op.toSlotKey !== "string" || op.toSlotKey === "") return { status: "rejected", code: "malformed" };
        if (op.toParentId === ROOT_ID && op.toSlotKey !== ROOT_SLOT) {
          return { status: "rejected", code: "slot-conflict" };
        }
        const list = this.ensureSlot(parent, op.toSlotKey, stampOf(op));
        const dep = this.missingOrigin(list, op.left, op.right);
        if (dep) return { status: "buffered", dep: `pos:${op.toParentId}:${op.toSlotKey}:${dep}` };
        const res = list.integrate(op.id, op.left, op.right, op.nodeId);
        if (!res.ok) return { status: "buffered", dep: `pos:${op.toParentId}:${op.toSlotKey}:${res.dep}` };
        this.integrateMove(op);
        return { status: "applied" };
      }

      case "nodeDelete": {
        const node = this.nodes.get(op.nodeId);
        if (!node) return { status: "buffered", dep: `node:${op.nodeId}` };
        if (op.nodeId === ROOT_ID) return { status: "rejected", code: "root-not-movable" };
        // El borrado es MONÓTONO: gana siempre y para siempre (§6.2). No
        // resucitamos nodos — un nodo resucitado frente a un tombstone no converge.
        node.deleted = true;
        return { status: "applied" };
      }

      case "propSet":
      case "propDelete": {
        const node = this.nodes.get(op.nodeId);
        if (!node) return { status: "buffered", dep: `node:${op.nodeId}` };
        if (typeof op.key !== "string" || op.key === "") return { status: "rejected", code: "malformed" };
        if (op.key === "id" && op.nodeId !== ROOT_ID) return { status: "rejected", code: "immutable-id" };
        if (node.slots.has(op.key)) return { status: "rejected", code: "slot-conflict" };
        if (op.nodeId === ROOT_ID) this.materializeRootProps();
        if (op.k === "propSet") node.props.set(op.key, op.value, stampOf(op));
        else node.props.delete(op.key, stampOf(op));
        return { status: "applied" };
      }

      case "textInsert": {
        const field = this.openField(op.nodeId, op.field);
        if (field === "missing-node") return { status: "buffered", dep: `node:${op.nodeId}` };
        if (!field) return { status: "rejected", code: "text-field-not-open" };
        if (!isPlainObject(op.atom)) return { status: "rejected", code: "malformed" };
        const dep = this.missingTextOrigin(field, op.left, op.right);
        if (dep) return { status: "buffered", dep: `tpos:${op.nodeId}:${op.field}:${dep}` };
        if (field.insert(op.id, op.left, op.right, op.atom, stampOf(op)) !== "ok") {
          return { status: "buffered", dep: `tpos:${op.nodeId}:${op.field}:${op.left ?? op.right ?? ""}` };
        }
        return { status: "applied" };
      }

      case "textDelete": {
        const field = this.openField(op.nodeId, op.field);
        if (field === "missing-node") return { status: "buffered", dep: `node:${op.nodeId}` };
        if (!field) return { status: "rejected", code: "text-field-not-open" };
        if (typeof op.pos !== "string") return { status: "rejected", code: "malformed" };
        if (!field.has(op.pos)) return { status: "buffered", dep: `tpos:${op.nodeId}:${op.field}:${op.pos}` };
        field.remove(op.pos, stampOf(op));
        return { status: "applied" };
      }

      case "markSet": {
        const field = this.openField(op.nodeId, op.field);
        if (field === "missing-node") return { status: "buffered", dep: `node:${op.nodeId}` };
        if (!field) return { status: "rejected", code: "text-field-not-open" };
        if (op.mark !== "bold" && op.mark !== "italic" && op.mark !== "link") {
          return { status: "rejected", code: "malformed" };
        }
        if (typeof op.pos !== "string") return { status: "rejected", code: "malformed" };
        if (!field.has(op.pos)) return { status: "buffered", dep: `tpos:${op.nodeId}:${op.field}:${op.pos}` };
        field.setMark(op.pos, op.mark, op.value, stampOf(op));
        return { status: "applied" };
      }

      case "shapeSet": {
        if (typeof op.key !== "string" || !isShapeKey(op.key)) return { status: "rejected", code: "malformed" };
        this.shape.set(op.key, op.value, stampOf(op));
        return { status: "applied" };
      }

      case "docReset":
        // No es una op CRDT (D11): la sala la trata subiendo el epoch. El núcleo
        // solo la SEÑALA — reiniciar es responsabilidad de la capa de sala (fase C).
        return { status: "reset", epoch: Number.isSafeInteger(op.epoch) ? op.epoch : this.epoch + 1 };

      default:
        return { status: "rejected", code: "malformed" };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Buffer causal (§2.4)                                              */
  /* ---------------------------------------------------------------- */

  private buffer(dep: string, op: CollabOp): void {
    if (this.pendingCount >= this.maxPending) {
      // Tope duro: un buffer sin techo es un vector de agotamiento de memoria.
      // Se descarta lo MÁS VIEJO y se anota — jamás en silencio.
      const firstKey = this.pending.keys().next().value as string | undefined;
      if (firstKey !== undefined) {
        const list = this.pending.get(firstKey)!;
        list.shift();
        this.pendingCount -= 1;
        if (list.length === 0) this.pending.delete(firstKey);
        this.runtimeWarnings.push(`buffer causal lleno (${this.maxPending}): se descartó la op más antigua`);
      }
    }
    const list = this.pending.get(dep);
    if (list) {
      if (list.some((o) => opIdKey(o.id) === opIdKey(op.id))) return;
      list.push(op);
    } else {
      this.pending.set(dep, [op]);
    }
    this.pendingCount += 1;
  }

  /** Reintenta las ops que esperaban lo que esta op acaba de crear. */
  private drain(op: CollabOp): void {
    const keys: string[] = [];
    switch (op.k) {
      case "nodeCreate":
        keys.push(`node:${op.nodeId}`);
        break;
      case "listInsert":
        keys.push(`pos:${op.parentId}:${op.slotKey}:${opIdKey(op.id)}`);
        break;
      case "listMove":
        keys.push(`pos:${op.toParentId}:${op.toSlotKey}:${opIdKey(op.id)}`);
        break;
      case "textInsert":
        keys.push(`tpos:${op.nodeId}:${op.field}:${opIdKey(op.id)}`);
        break;
      default:
        break;
    }
    for (const key of keys) {
      const waiting = this.pending.get(key);
      if (!waiting) continue;
      this.pending.delete(key);
      this.pendingCount -= waiting.length;
      for (const queued of waiting) this.apply(queued);
    }
  }

  /** Ops que siguen esperando una dependencia causal (para tests/diagnóstico). */
  get pendingOps(): number {
    return this.pendingCount;
  }

  /* ---------------------------------------------------------------- */
  /* Moves (§3.2.1)                                                    */
  /* ---------------------------------------------------------------- */

  private integrateMove(op: ListMoveOp): void {
    const entry: MoveEntry = { op, pos: opIdKey(op.id), applied: false };
    const last = this.moveLog[this.moveLog.length - 1];
    if (!last || compareStamp(stampOf(op), stampOf(last.op)) > 0) {
      // Vía rápida: llega en orden ⇒ no hay nada que deshacer ni rehacer.
      this.moveLog.push(entry);
      this.applyMoveEntry(entry);
      return;
    }
    let i = this.moveLog.length;
    while (i > 0 && compareStamp(stampOf(this.moveLog[i - 1].op), stampOf(op)) > 0) i -= 1;
    this.moveLog.splice(i, 0, entry);
    this.replayMoves();
  }

  /** undo → apply → redo, materializado como replay del log completo. */
  private replayMoves(): void {
    for (const node of this.nodes.values()) node.pos = node.basePos;
    for (const entry of this.moveLog) {
      entry.applied = false;
      this.applyMoveEntry(entry);
    }
  }

  private applyMoveEntry(entry: MoveEntry): void {
    const node = this.nodes.get(entry.op.nodeId);
    if (!node) return;
    // Descartar SOLO si crea ciclo EN ESTE ESTADO (Kleppmann): descartarlo por
    // el orden de llegada es lo que no converge.
    if (this.createsCycle(entry.op.nodeId, entry.op.toParentId)) return;
    node.pos = { parentId: entry.op.toParentId, slotKey: entry.op.toSlotKey, pos: entry.pos };
    entry.applied = true;
  }

  private createsCycle(nodeId: string, targetParentId: string): boolean {
    if (nodeId === targetParentId) return true;
    let cur: string | null = targetParentId;
    const seen = new Set<string>();
    while (cur && cur !== ROOT_ID) {
      if (cur === nodeId) return true;
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = this.nodes.get(cur)?.pos?.parentId ?? null;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Utilidades internas                                               */
  /* ---------------------------------------------------------------- */

  private ensureSlot(parent: CrdtNode, slotKey: string, stamp?: Stamp): FugueList<string> {
    const existing = parent.slots.get(slotKey);
    if (existing) return existing;
    const list = new FugueList<string>();
    parent.slots.set(slotKey, list);
    // Orden determinista de los slots NUEVOS en la serialización (D12): por HLC
    // de creación, no por orden de llegada.
    parent.slotCreated.set(slotKey, stamp ?? ZERO_STAMP);
    return list;
  }

  private missingOrigin(list: FugueList<string>, left: PosRef | null, right: PosRef | null): PosRef | null {
    if (left !== null && !list.has(left)) return left;
    if (right !== null && !list.has(right)) return right;
    return null;
  }

  private missingTextOrigin(field: TextField, left: PosRef | null, right: PosRef | null): PosRef | null {
    if (left !== null && !field.has(left)) return left;
    if (right !== null && !field.has(right)) return right;
    return null;
  }

  private openField(nodeId: string, field: string): TextField | null | "missing-node" {
    const node = this.nodes.get(nodeId);
    if (!node) return "missing-node";
    if (typeof field !== "string") return null;
    return node.text.get(field) ?? null;
  }

  private materializeRootProps(): void {
    if (this.rootPropsPresent) return;
    // Espejo de `applySetRootProps`: un root sin `props` plano la materializa.
    this.rootPropsPresent = true;
    this.shape.set("rootKeyPresent", true, ZERO_STAMP);
  }

  private isLiveAt(nodeId: string, pos: PosRef): boolean {
    const node = this.nodes.get(nodeId);
    return !!node && !node.deleted && node.pos !== null && node.pos.pos === pos;
  }

  /* ---------------------------------------------------------------- */
  /* Proyección → VersoDoc                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Proyecta el estado a un `VersoDoc` válido: `fromNormalized` sobre él
   * produce el `_puck_data` canónico (gate G-F8.1-c).
   */
  toDoc(): VersoDoc {
    const nodes: Record<string, VersoNode> = {};
    const warnings = [...this.baseWarnings, ...this.runtimeWarnings];
    const seenIds = new Set<string>();
    const root = this.nodes.get(ROOT_ID)!;

    const emitChildren = (parent: CrdtNode, slotKey: string): string[] => {
      const list = parent.slots.get(slotKey);
      if (!list) return [];
      const out: string[] = [];
      for (const pos of list.livePositions()) {
        const childId = list.valueAt(pos);
        if (childId === undefined) continue;
        const child = this.nodes.get(childId);
        if (!child || child.deleted) continue;
        // Una posición solo cuenta si es la posición VIVA del nodo (un move
        // dejó la anterior como tombstone) — y un nodo se emite UNA vez.
        if (!child.pos || child.pos.pos !== pos || child.pos.parentId !== parent.nodeId) continue;
        if (child.pos.slotKey !== slotKey) continue;
        if (seenIds.has(childId)) continue;
        seenIds.add(childId);
        out.push(childId);
        emitNode(child, parent.nodeId, slotKey, out.length - 1);
      }
      return out;
    };

    const emitNode = (node: CrdtNode, parentId: string, slotKey: string, index: number): void => {
      const props = node.props.toObject();
      for (const [field, text] of node.text) {
        if (!text.isDirty || !Object.hasOwn(props, field)) continue;
        // Arbitraje edición-fina vs reemplazo del campo entero (§3.2.3): gana el
        // HLC mayor. Un `propSet` sin HLC (valor del snapshot) siempre pierde
        // contra una edición de texto — que es justo lo que queremos.
        const propStamp = node.props.stampOf(field);
        const textStamp = text.lastChange;
        if (propStamp && textStamp && compareStamp(propStamp, textStamp) > 0) continue;
        props[field] = text.serialize();
      }
      const slots: Record<string, string[]> = {};
      const out: VersoNode = {
        id: node.nodeId,
        type: node.type,
        props: props as VersoNode["props"],
        slots,
        parentId,
        slotKey,
        index,
      };
      if (node.keyOrder) out.keyOrder = [...node.keyOrder];
      if (node.extras) out.extras = { ...node.extras };
      setOwn(nodes, node.nodeId, out);
      for (const key of this.slotKeysInOrder(node)) setOwn(slots, key, emitChildren(node, key));
    };

    const rootChildren = emitChildren(root, ROOT_SLOT);

    // `root` con su orden de claves ORIGINAL (D12): los docs reales guardan
    // `root` antes que `content`, y `props` en su posición original dentro de root.
    const rootKeyOrder = asStringArray(this.shape.get("rootKeyOrder"));
    const rootOut: Record<string, unknown> = {};
    const emittedRootKeys = new Set<string>();
    const emitRootKey = (k: string): void => {
      if (emittedRootKeys.has(k)) return;
      if (k === "props" && this.rootPropsPresent) {
        rootOut.props = root.props.toObject();
        emittedRootKeys.add(k);
      } else if (this.rootExtras.has(k)) {
        setOwn(rootOut, k, this.rootExtras.get(k));
        emittedRootKeys.add(k);
      }
    };
    for (const k of rootKeyOrder) emitRootKey(k);
    for (const k of this.rootExtras.keysInOrder()) emitRootKey(k);
    if (this.rootPropsPresent) emitRootKey("props");

    const extras: Record<string, unknown> = {};
    const orphanZones: Record<string, VersoItem[]> = {};
    for (const key of this.shape.keysInOrder()) {
      if (key.startsWith("extras:")) setOwn(extras, key.slice(7), this.shape.get(key));
      else if (key.startsWith("orphanZones:")) setOwn(orphanZones, key.slice(12), this.shape.get(key) as VersoItem[]);
    }

    return {
      nodes,
      rootChildren,
      root: rootOut as VersoDoc["root"],
      orphanZones,
      zonesKeyPresent: this.shape.get("zonesKeyPresent") === true,
      contentKeyState: asContentKeyState(this.shape.get("contentKeyState")),
      rootKeyPresent: this.shape.get("rootKeyPresent") === true,
      topKeyOrder: asStringArray(this.shape.get("topKeyOrder")),
      extras,
      warnings,
    };
  }

  /** Slots en orden determinista: los del snapshot primero, los nuevos por HLC. */
  private slotKeysInOrder(node: CrdtNode): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const k of node.baseSlotOrder) {
      if (node.slots.has(k)) out.push(k);
      seen.add(k);
    }
    const fresh: { key: string; stamp: Stamp }[] = [];
    for (const k of node.slots.keys()) {
      if (seen.has(k)) continue;
      fresh.push({ key: k, stamp: node.slotCreated.get(k) ?? ZERO_STAMP });
    }
    fresh.sort((a, b) => {
      const byHlc = compareStamp(a.stamp, b.stamp);
      if (byHlc !== 0) return byHlc;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    for (const f of fresh) out.push(f.key);
    return out;
  }

  /**
   * Firma canónica del ESTADO (no de la proyección): dos réplicas convergentes
   * la tienen idéntica. Incluye tombstones y posiciones — detecta divergencias
   * que la serialización todavía no muestra (una bomba de relojería).
   */
  stateSignature(): string {
    const parts: string[] = [];
    for (const nodeId of [...this.nodes.keys()].sort()) {
      const n = this.nodes.get(nodeId)!;
      const slots = [...n.slots.keys()].sort().map((k) => `${k}=${n.slots.get(k)!.debugDump()}`);
      const text = [...n.text.keys()].sort().map((k) => `${k}=${n.text.get(k)!.debugDump()}`);
      parts.push(
        [
          nodeId,
          n.type,
          n.deleted ? "†" : "",
          JSON.stringify(n.props.toObject()),
          JSON.stringify(n.pos),
          slots.join(";"),
          text.join(";"),
        ].join("|"),
      );
    }
    parts.push(`shape=${JSON.stringify(this.shape.toObject())}`);
    parts.push(`rootExtras=${JSON.stringify(this.rootExtras.toObject())}`);
    return parts.join("\n");
  }
}

/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const PROTO_KEY = "__proto__";

/** ¿La op intenta usar `__proto__` como clave de slot, prop, campo o forma? */
function hasProtoKey(op: CollabOp): boolean {
  const o = op as unknown as Record<string, unknown>;
  if (typeof o.key === "string" && (o.key === PROTO_KEY || o.key.endsWith(`:${PROTO_KEY}`))) return true;
  if (o.slotKey === PROTO_KEY || o.toSlotKey === PROTO_KEY || o.field === PROTO_KEY) return true;
  if (op.k === "nodeCreate") {
    if (Array.isArray(op.slotKeys) && op.slotKeys.includes(PROTO_KEY)) return true;
    if (Array.isArray(op.propOrder) && op.propOrder.includes(PROTO_KEY)) return true;
    if (isPlainObject(op.props) && Object.hasOwn(op.props, PROTO_KEY)) return true;
  }
  return false;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asContentKeyState(v: unknown): VersoDoc["contentKeyState"] {
  return v === "absent" || v === "verbatim" ? v : "array";
}

const SHAPE_SCALARS = new Set(["topKeyOrder", "contentKeyState", "rootKeyPresent", "zonesKeyPresent", "rootKeyOrder"]);

function isShapeKey(key: string): key is ShapeKey {
  return SHAPE_SCALARS.has(key) || key.startsWith("extras:") || key.startsWith("orphanZones:");
}

/** Azúcar: estado CRDT desde un documento normalizado (§3.4). */
export function toCrdt(doc: VersoDoc, opts?: CrdtDocOptions): CrdtDoc {
  return CrdtDoc.fromDoc(doc, opts);
}

/** Azúcar simétrica: proyección del estado a documento normalizado. */
export function fromCrdt(state: CrdtDoc): VersoDoc {
  return state.toDoc();
}

export type { CrdtNode, NodePosition, RejectionCode };
