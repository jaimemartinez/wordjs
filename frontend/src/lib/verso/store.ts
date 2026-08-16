/**
 * Verso — store del editor: transacciones, historia y suscripción por nodo.
 *
 * CONTRATO (F2):
 * - El doc SOLO cambia vía comandos dentro de `transact` (o undo/redo, que
 *   re-aplican inversos/comandos ya registrados sin crear historia nueva).
 * - Una transacción con >=1 comando = UNA entrada de historia = UNA llamada a
 *   `onChange`. Si la FUNCIÓN de la transacción lanza, se aplican los inversos
 *   ya generados (rollback total) y `transact` devuelve false: el doc publicado
 *   queda EXACTO (misma referencia) al de antes. Las excepciones de `onChange`
 *   se contienen y loguean; la transacción committeada se mantiene (los
 *   suscriptores ya fueron notificados y transact/undo/redo devuelven su
 *   boolean con normalidad).
 * - El objeto `tx` se SELLA al salir de `transact` (commit o rollback): usarlo
 *   después (p.ej. desde una continuación async) lanza
 *   VersoCommandError("transaction-sealed") sin tocar doc ni historia.
 * - Coalescencia: transacciones consecutivas con el mismo `coalesceKey` dentro
 *   de `VERSO_HISTORY_COALESCE_MS` se funden en una entrada (mutada en sitio),
 *   hasta `VERSO_COALESCE_MAX_COMMANDS` comandos por entrada. Un undo/redo corta
 *   la coalescencia (barrera): nunca se funde a través de un salto de historia.
 * - La historia retiene como máximo `VERSO_HISTORY_LIMIT` entradas: al exceder,
 *   se descarta la más vieja.
 * - selection / inlineEditing / dragPreview NO tocan el doc ni la historia.
 * - Suscripción: `subscribe(listener, selector?)` notifica solo si la slice
 *   cambia por Object.is; `subscribeNode(nodeId, listener)` solo si ese
 *   VersoNode cambió de REFERENCIA — base del render por-nodo.
 */

import {
  type DragPreview,
  type HistoryEntry,
  type SlotResolver,
  type VersoCommand,
  type VersoData,
  type VersoDoc,
  type VersoEditorState,
  type VersoHistoryCommand,
  type VersoItem,
  type VersoNode,
  type VersoSelection,
} from "./types";
import { fromNormalized, toNormalized } from "./normalize";
import { applyCommand, VersoCommandError, type ApplyCommandOptions } from "./commands";

/** Ventana de coalescencia de historia (ms). Reloj inyectable vía `now` en tests. */
export const VERSO_HISTORY_COALESCE_MS = 250;

/** Máximo de comandos que una entrada acepta por coalescencia; al alcanzarlo, la siguiente transacción abre entrada nueva. */
export const VERSO_COALESCE_MAX_COMMANDS = 500;

/** Máximo de entradas del undo stack; al exceder, se descarta la más vieja. */
export const VERSO_HISTORY_LIMIT = 100;

export interface VersoTransactionApi {
  insertNode(item: VersoItem, parentId: string, slotKey: string, index: number): void;
  moveNode(nodeId: string, toParentId: string, toSlotKey: string, toIndex: number): void;
  removeNode(nodeId: string): void;
  setProps(nodeId: string, patch: Record<string, unknown>): void;
  setRootProps(patch: Record<string, unknown>): void;
  duplicateSubtree(nodeId: string, idMap?: Record<string, string>): void;
  replaceData(data: VersoData): void;
}

export interface TransactOptions {
  coalesceKey?: string;
  label?: string;
}

export interface CreateEditorOptions {
  initialData: VersoData;
  isSlot?: SlotResolver;
  /** Una llamada por transacción confirmada y por cada undo/redo, con el doc serializado. */
  onChange?: (data: VersoData) => void;
  /** Ids frescos para duplicateSubtree (default: crypto.randomUUID). */
  generateId?: () => string;
  /** Reloj inyectable para tests de coalescencia (default: Date.now). */
  now?: () => number;
}

/** De dónde salió un lote de comandos efectivos. `remote` NUNCA se emite (ver `applyRemoteDoc`). */
export type VersoCommandOrigin = "transact" | "undo" | "redo";

export interface VersoCommandBatch {
  /**
   * Los comandos EFECTIVOS — los que devuelve `applyCommand`, con los índices ya clampados y el
   * `idMap` materializado. Nunca los crudos: dos réplicas que apliquen "inserta en el índice 99"
   * sobre listas de distinta longitud acaban con documentos distintos, y ahí la convergencia deja
   * de significar nada.
   */
  commands: readonly VersoHistoryCommand[];
  origin: VersoCommandOrigin;
}

export interface EditorHandle {
  /** Serializa el doc actual a la forma persistida (`_puck_data`). */
  getData(): VersoData;
  getDoc(): VersoDoc;
  getState(): VersoEditorState;
  transact(fn: (tx: VersoTransactionApi) => void, opts?: TransactOptions): boolean;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  subscribe<T = VersoEditorState>(
    listener: (slice: T) => void,
    selector?: (state: VersoEditorState) => T,
  ): () => void;
  /** Notifica solo cuando ese VersoNode cambia de referencia (o desaparece). */
  subscribeNode(nodeId: string, listener: (node: VersoNode | undefined) => void): () => void;
  /**
   * Suscripción a los comandos efectivos que el store ACABA de aplicar. Existe para la
   * colaboración (F8): el transporte convierte cada comando en operaciones CRDT.
   *
   * Se emite DESPUÉS de `emitDocChange`, así que un oyente que lea `getDoc()` ve el documento ya
   * committeado. Un `undo` local también se emite —deshacer es una edición como otra cualquiera y
   * las demás réplicas tienen que verla—; lo que NO se emite jamás es lo que llega por
   * `applyRemoteDoc`, porque devolverlo al transporte sería un eco infinito.
   */
  subscribeCommands(listener: (batch: VersoCommandBatch) => void): () => void;
  /**
   * Publica un documento venido de OTRA réplica, ya proyectado por el CRDT. No toca la pila de
   * historia y no emite al sink de comandos.
   *
   * SOBRE EL DESHACER (limitación conocida, documentada a propósito): las entradas de historia que
   * ya estaban guardadas describen inversos de un documento anterior, y tras un cambio ajeno pueden
   * no encajar. No se vacía la pila —perder el deshacer cada vez que otro teclea sería peor que el
   * problema—: el `undo` es peek-then-commit, así que si un inverso ya no aplica, la entrada se
   * conserva y el documento publicado no se corrompe. El deshacer selectivo (deshacer solo lo tuyo)
   * es trabajo del CRDT, no del store.
   *
   * `resetHistory` es para el documento INICIAL de la sala, donde no hay nada tuyo que conservar.
   */
  applyRemoteDoc(nextDoc: VersoDoc, opts?: { resetHistory?: boolean }): boolean;
  select(nodeId: string | null): void;
  setInlineEditing(nodeId: string | null): void;
  setDragPreview(preview: DragPreview | null): void;
  /** Cierra el modo de edición inline (el contenido ya se comiteó vía transact). */
  commitInline(): void;
  /** Sustitución completa del documento: UNA entrada de historia (un solo undo). */
  replaceData(data: VersoData): boolean;
  destroy(): void;
}

interface Subscription {
  listener: (slice: unknown) => void;
  selector?: (state: VersoEditorState) => unknown;
  last: unknown;
}

interface NodeSubscription {
  nodeId: string;
  listener: (node: VersoNode | undefined) => void;
  last: VersoNode | undefined;
}

export function createEditor(options: CreateEditorOptions): EditorHandle {
  const { isSlot, onChange, generateId } = options;
  const now = options.now ?? (() => Date.now());
  const applyOpts: ApplyCommandOptions = { isSlot, generateId };

  let doc: VersoDoc = toNormalized(options.initialData, isSlot);
  let selection: VersoSelection = { nodeId: null };
  let inlineEditingId: string | null = null;
  let dragPreview: DragPreview | null = null;
  let state: VersoEditorState = { doc, selection, inlineEditingId, dragPreview };

  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  /** true tras undo/redo o replace: la siguiente transacción no coalesce con la entrada previa. */
  let coalesceBarrier = false;
  let destroyed = false;
  let inTransaction = false;

  const subs = new Set<Subscription>();
  const nodeSubs = new Set<NodeSubscription>();
  const commandSubs = new Set<(batch: VersoCommandBatch) => void>();

  /**
   * Entrega de los comandos efectivos al sink. Contenida igual que `onChange`: el transporte de
   * colaboración es un consumidor EXTERNO y su excepción no puede tumbar una edición ya committeada.
   */
  function emitCommands(commands: readonly VersoHistoryCommand[], origin: VersoCommandOrigin): void {
    if (destroyed || commands.length === 0 || commandSubs.size === 0) return;
    const batch: VersoCommandBatch = { commands, origin };
    for (const listener of [...commandSubs]) {
      try {
        listener(batch);
      } catch (e) {
        console.error("verso: el sink de comandos lanzó", e);
      }
    }
  }

  function rebuildState(): void {
    // Higiene: referencias a nodos desaparecidos (undo/remove/replace) se limpian.
    if (selection.nodeId !== null && !doc.nodes[selection.nodeId]) selection = { nodeId: null };
    if (inlineEditingId !== null && !doc.nodes[inlineEditingId]) inlineEditingId = null;
    state = { doc, selection, inlineEditingId, dragPreview };
  }

  function notify(): void {
    if (destroyed) return;
    for (const sub of [...subs]) {
      if (sub.selector) {
        const slice = sub.selector(state);
        if (Object.is(slice, sub.last)) continue;
        sub.last = slice;
        sub.listener(slice);
      } else {
        sub.listener(state);
      }
    }
    for (const ns of [...nodeSubs]) {
      const node = doc.nodes[ns.nodeId];
      if (Object.is(node, ns.last)) continue;
      ns.last = node;
      ns.listener(node);
    }
  }

  function emitDocChange(): void {
    rebuildState();
    // Primero los suscriptores (la UI siempre ve el doc committeado); después el
    // onChange externo, contenido: su excepción no puede romper el commit.
    notify();
    if (onChange) {
      try {
        onChange(fromNormalized(doc));
      } catch (e) {
        console.error("verso: onChange lanzó", e);
      }
    }
  }

  function transact(fn: (tx: VersoTransactionApi) => void, opts: TransactOptions = {}): boolean {
    if (destroyed) return false;
    if (inTransaction) throw new Error("verso: transact reentrante no soportado");
    inTransaction = true;
    // Sellado: se activa al salir de transact (commit O rollback). Una continuación
    // async que retenga `tx` no puede escribir fuera de la transacción.
    let sealed = false;
    let working = doc;
    const commands: VersoHistoryCommand[] = [];
    const inversesInOrder: VersoHistoryCommand[] = [];
    const run = (cmd: VersoCommand): void => {
      if (sealed) {
        throw new VersoCommandError(
          "transaction-sealed",
          "verso: la transacción ya está sellada — transact terminó (¿continuación async?)",
        );
      }
      const result = applyCommand(working, cmd, applyOpts);
      working = result.doc;
      commands.push(result.command);
      inversesInOrder.push(result.inverse);
    };
    const tx: VersoTransactionApi = {
      insertNode: (item, parentId, slotKey, index) =>
        run({ kind: "insertNode", item, parentId, slotKey, index }),
      moveNode: (nodeId, toParentId, toSlotKey, toIndex) =>
        run({ kind: "moveNode", nodeId, toParentId, toSlotKey, toIndex }),
      removeNode: (nodeId) => run({ kind: "removeNode", nodeId }),
      setProps: (nodeId, patch) => run({ kind: "setProps", nodeId, patch }),
      setRootProps: (patch) => run({ kind: "setRootProps", patch }),
      duplicateSubtree: (nodeId, idMap) => run({ kind: "duplicateSubtree", nodeId, idMap }),
      replaceData: (data) => run({ kind: "replaceData", data }),
    };
    try {
      fn(tx);
    } catch {
      // Rollback total: aplicar los inversos ya generados en orden inverso.
      // El doc publicado nunca cambió (inmutabilidad): queda la MISMA referencia.
      try {
        for (let i = inversesInOrder.length - 1; i >= 0; i--) {
          working = applyCommand(working, inversesInOrder[i], applyOpts).doc;
        }
      } catch {
        /* el doc publicado sigue intacto pase lo que pase */
      }
      sealed = true;
      inTransaction = false;
      return false;
    }
    sealed = true;
    inTransaction = false;
    if (commands.length === 0) return true;

    const at = now();
    const last = undoStack[undoStack.length - 1];
    const canCoalesce =
      opts.coalesceKey !== undefined &&
      !coalesceBarrier &&
      last !== undefined &&
      last.coalesceKey === opts.coalesceKey &&
      at - last.at <= VERSO_HISTORY_COALESCE_MS &&
      last.commands.length < VERSO_COALESCE_MAX_COMMANDS;
    if (canCoalesce && last) {
      // Fusión EN SITIO (la entrada es privada del store: nadie retiene la
      // referencia): comandos e inversos se anexan en orden cronológico.
      last.commands.push(...commands);
      last.inverse.push(...inversesInOrder);
      last.at = at;
    } else {
      // Copias: los arrays de trabajo quedan retenidos por el closure de `run`
      // — la entrada de historia jamás comparte esa referencia viva.
      const entry: HistoryEntry = { commands: commands.slice(), inverse: inversesInOrder.slice(), at };
      if (opts.coalesceKey !== undefined) entry.coalesceKey = opts.coalesceKey;
      if (opts.label !== undefined) entry.label = opts.label;
      undoStack.push(entry);
      if (undoStack.length > VERSO_HISTORY_LIMIT) undoStack.shift();
    }
    redoStack.length = 0;
    coalesceBarrier = false;
    doc = working;
    emitDocChange();
    // Copia: `commands` sigue vivo en el closure de `run` y, si hubo coalescencia, sus elementos
    // están además dentro de la entrada de historia. El sink recibe una lista suya.
    emitCommands(commands.slice(), "transact");
    return true;
  }

  function undo(): boolean {
    if (destroyed || undoStack.length === 0) return false;
    // Peek, no pop: si algún inverso lanza, la entrada se queda donde estaba y
    // el doc publicado no cambia.
    const entry = undoStack[undoStack.length - 1];
    let working = doc;
    // Los EFECTIVOS de deshacer, en el orden en que se aplican: es lo que viaja a las otras
    // réplicas (un inverso crudo tendría los mismos índices sin clampar que un comando crudo).
    const applied: VersoHistoryCommand[] = [];
    try {
      // Inversos en orden CRONOLÓGICO: deshacer = aplicarlos hacia atrás.
      for (let i = entry.inverse.length - 1; i >= 0; i--) {
        const result = applyCommand(working, entry.inverse[i], applyOpts);
        working = result.doc;
        applied.push(result.command);
      }
    } catch (e) {
      console.error("verso: undo falló — la entrada se conserva y el doc queda intacto", e);
      return false;
    }
    undoStack.pop();
    redoStack.push(entry);
    coalesceBarrier = true;
    doc = working;
    emitDocChange();
    emitCommands(applied, "undo");
    return true;
  }

  function redo(): boolean {
    if (destroyed || redoStack.length === 0) return false;
    const entry = redoStack[redoStack.length - 1];
    let working = doc;
    const applied: VersoHistoryCommand[] = [];
    try {
      for (const cmd of entry.commands) {
        const result = applyCommand(working, cmd, applyOpts);
        working = result.doc;
        applied.push(result.command);
      }
    } catch (e) {
      console.error("verso: redo falló — la entrada se conserva y el doc queda intacto", e);
      return false;
    }
    redoStack.pop();
    undoStack.push(entry);
    coalesceBarrier = true;
    doc = working;
    emitDocChange();
    emitCommands(applied, "redo");
    return true;
  }

  function applyRemoteDoc(nextDoc: VersoDoc, opts: { resetHistory?: boolean } = {}): boolean {
    if (destroyed) return false;
    // Una transacción a medias tiene su propio `working` sobre el doc de ANTES; publicar aquí
    // haría que al confirmarla se perdiera lo remoto. El transporte reintenta en el siguiente tic.
    if (inTransaction) return false;
    if (Object.is(nextDoc, doc)) return true;
    doc = nextDoc;
    if (opts.resetHistory) {
      undoStack.length = 0;
      redoStack.length = 0;
    }
    // Lo que teclees a continuación no debe fundirse con una entrada anterior al cambio ajeno.
    coalesceBarrier = true;
    emitDocChange();
    return true;
  }

  function setUiState(mutate: () => boolean): void {
    if (destroyed) return;
    if (!mutate()) return;
    state = { doc, selection, inlineEditingId, dragPreview };
    notify();
  }

  return {
    getData: () => fromNormalized(doc),
    getDoc: () => doc,
    getState: () => state,
    transact,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    subscribe<T = VersoEditorState>(
      listener: (slice: T) => void,
      selector?: (s: VersoEditorState) => T,
    ): () => void {
      const sub: Subscription = {
        listener: listener as (slice: unknown) => void,
        last: selector ? selector(state) : undefined,
      };
      if (selector) sub.selector = selector as (s: VersoEditorState) => unknown;
      subs.add(sub);
      return () => {
        subs.delete(sub);
      };
    },
    subscribeNode(nodeId, listener) {
      const sub: NodeSubscription = { nodeId, listener, last: doc.nodes[nodeId] };
      nodeSubs.add(sub);
      return () => {
        nodeSubs.delete(sub);
      };
    },
    subscribeCommands(listener) {
      commandSubs.add(listener);
      return () => {
        commandSubs.delete(listener);
      };
    },
    applyRemoteDoc,
    select(nodeId) {
      setUiState(() => {
        const next = nodeId !== null && doc.nodes[nodeId] ? nodeId : null;
        if (selection.nodeId === next) return false;
        selection = { nodeId: next };
        return true;
      });
    },
    setInlineEditing(nodeId) {
      setUiState(() => {
        const next = nodeId !== null && doc.nodes[nodeId] ? nodeId : null;
        if (inlineEditingId === next) return false;
        inlineEditingId = next;
        return true;
      });
    },
    setDragPreview(preview) {
      setUiState(() => {
        if (Object.is(dragPreview, preview)) return false;
        dragPreview = preview;
        return true;
      });
    },
    commitInline() {
      setUiState(() => {
        if (inlineEditingId === null) return false;
        inlineEditingId = null;
        return true;
      });
    },
    replaceData(data) {
      return transact((tx) => tx.replaceData(data), { label: "replaceData" });
    },
    destroy() {
      destroyed = true;
      subs.clear();
      nodeSubs.clear();
      commandSubs.clear();
    },
  };
}
