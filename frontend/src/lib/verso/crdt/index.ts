/**
 * Verso CRDT — API pública del núcleo (F8.1).
 *
 * 100% puro: sin red, sin DOM, sin store. El transporte (WebSocket + bus
 * Redis) y el enganche con `transact()` son fases posteriores — este módulo
 * solo sabe de operaciones, convergencia y proyección a `VersoDoc`.
 *
 * Contrato completo: documentation/verso/crdt-spec.md
 */

export {
  bumpVersionVector,
  compareHlc,
  compareOpId,
  createSiteId,
  HlcClock,
  isRealSiteId,
  MAX_CLOCK_DRIFT_MS,
  opIdKey,
  parseOpId,
  SEED_PREFIX,
  SEED_SITE,
  textSeedSite,
  type Hlc,
  type OpId,
  type PosRef,
  type SiteId,
  type VersionVector,
} from "./identity";

export { END_POS, FugueList, ROOT_POS, type IntegrateResult, type LiveEntry, type Side } from "./fugue";
export { LwwMap } from "./lww";
export { sanitizeWireMarks, TextField } from "./text";
export { CrdtDoc, fromCrdt, toCrdt, type CrdtDocOptions } from "./state";
export {
  atomsOf,
  commandToOps,
  hashJson,
  type BridgeError,
  type BridgeErrorCode,
  type BridgeOptions,
  type BridgeResult,
} from "./bridge";
export type {
  ApplyResult,
  ApplyStatus,
  CollabOp,
  ListInsertOp,
  ListMoveOp,
  MarkName,
  MarkSetOp,
  NodeCreateOp,
  NodeDeleteOp,
  PropDeleteOp,
  PropSetOp,
  RejectionCode,
  RichTextResolver,
  ShapeKey,
  ShapeSetOp,
  TextDeleteOp,
  TextInsertOp,
  WireAtom,
} from "./types";
