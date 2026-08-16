/**
 * Verso CRDT — catálogo de operaciones (§3.1) y tipos del núcleo.
 *
 * Las ops son JSON planas y auditables a propósito (D6 / §4.5): el servidor
 * tiene que poder SANEARLAS en el ingest sin decodificar un blob binario.
 */

import type { Hlc, OpId, PosRef } from "./identity";
import type { LinkAttrs, Marks } from "../inline-engine";

/** Marcas replicadas por átomo con LWW-HLC (§1.4.3). */
export type MarkName = "bold" | "italic" | "link";

/** Átomo transportado por una op de texto (1 code unit, o un hard-break). */
export interface WireAtom {
  br: boolean;
  ch: string;
  marks: Marks;
}

export interface NodeCreateOp {
  k: "nodeCreate";
  id: OpId;
  nodeId: string;
  type: string;
  /** Props SIN los arrays de slot. El orden viaja aparte para el byte-exacto. */
  props: Record<string, unknown>;
  propOrder: string[];
  /** Slots declarados del nodo (aunque estén vacíos: `clave: []` se serializa). */
  slotKeys: string[];
  /** `VersoNode.keyOrder` del emisor — solo se materializa con ≥1 slot (D12). */
  keyOrder?: string[];
  /** Claves desconocidas a nivel de item (p.ej. `readOnly`), verbatim. */
  extras?: Record<string, unknown>;
  hlc: Hlc;
}

export interface ListInsertOp {
  k: "listInsert";
  id: OpId;
  parentId: string;
  slotKey: string;
  /** Posiciones vecinas, NUNCA un índice (§3.2): el índice es lo que interleava. */
  left: PosRef | null;
  right: PosRef | null;
  nodeId: string;
}

export interface ListMoveOp {
  k: "listMove";
  id: OpId;
  nodeId: string;
  toParentId: string;
  toSlotKey: string;
  left: PosRef | null;
  right: PosRef | null;
  hlc: Hlc;
}

export interface NodeDeleteOp {
  k: "nodeDelete";
  id: OpId;
  nodeId: string;
  hlc: Hlc;
}

export interface PropSetOp {
  k: "propSet";
  id: OpId;
  nodeId: string;
  key: string;
  value: unknown;
  hlc: Hlc;
}

export interface PropDeleteOp {
  k: "propDelete";
  id: OpId;
  nodeId: string;
  key: string;
  hlc: Hlc;
}

/**
 * Las ops de texto llevan `hlc` — añadido sobre el catálogo de la spec §3.1,
 * que no se lo daba. Sin él no hay forma DETERMINISTA de arbitrar entre una
 * edición fina del campo y un `propSet` que reemplaza el campo entero (pegar
 * HTML desde un campo lateral, §3.2.3): el que gana tiene que salir del reloj,
 * no del orden de llegada. Es un dato auditable más en un frame JSON.
 */
export interface TextInsertOp {
  k: "textInsert";
  id: OpId;
  nodeId: string;
  field: string;
  left: PosRef | null;
  right: PosRef | null;
  atom: WireAtom;
  hlc: Hlc;
}

export interface TextDeleteOp {
  k: "textDelete";
  id: OpId;
  nodeId: string;
  field: string;
  pos: PosRef;
  hlc: Hlc;
}

export interface MarkSetOp {
  k: "markSet";
  id: OpId;
  nodeId: string;
  field: string;
  pos: PosRef;
  mark: MarkName;
  value: boolean | LinkAttrs | null;
  hlc: Hlc;
}

/** Metadatos de FORMA del documento (D12) — sin ellos el round-trip se rompe. */
export type ShapeKey =
  | "topKeyOrder"
  | "contentKeyState"
  | "rootKeyPresent"
  | "zonesKeyPresent"
  | "rootKeyOrder"
  | `extras:${string}`
  | `orphanZones:${string}`;

export interface ShapeSetOp {
  k: "shapeSet";
  id: OpId;
  key: ShapeKey;
  value: unknown;
  hlc: Hlc;
}

/** No es una op CRDT (D11): reinicia la sala. El núcleo solo la SEÑALA. */
export interface DocResetOp {
  k: "docReset";
  id: OpId;
  epoch: number;
  snapshotHash: string;
}

export type CollabOp =
  | NodeCreateOp
  | ListInsertOp
  | ListMoveOp
  | NodeDeleteOp
  | PropSetOp
  | PropDeleteOp
  | TextInsertOp
  | TextDeleteOp
  | MarkSetOp
  | ShapeSetOp
  | DocResetOp;

export type ApplyStatus = "applied" | "duplicate" | "buffered" | "rejected" | "reset";

export type RejectionCode =
  | "malformed"
  | "forged-seed-site"
  | "node-not-found"
  | "node-deleted"
  | "root-not-movable"
  | "immutable-id"
  | "slot-conflict"
  | "text-field-not-open"
  | "position-not-found"
  | "epoch";

export interface ApplyResult {
  status: ApplyStatus;
  /** Motivo TIPADO del rechazo (nunca una excepción: §fuzzing G-F8.6-a). */
  code?: RejectionCode;
  /** Dependencia causal que falta cuando `status === "buffered"`. */
  dep?: string;
  /** Epoch solicitado cuando `status === "reset"`. */
  epoch?: number;
}

/**
 * Resolutor de campos de texto RICO. Debe ser el MISMO en toda la sala (sale
 * del registry de bloques): si dos réplicas discrepan sobre qué campo es rico,
 * una acepta ops de texto que la otra rechaza y divergen. Por defecto, ninguno
 * — el núcleo es puro y no conoce el registry.
 */
export type RichTextResolver = (type: string, propKey: string) => boolean;
