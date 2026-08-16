/**
 * Verso — modelo de documento del editor.
 *
 * CONTRATO EXTERNO (innegociable, ver documentation/verso/f0-audit-core.md):
 * la forma persistida en la meta `_puck_data` es canónica y byte-exacta:
 *   { content: [{ type, props: { id, ... } }], root: { props: {...} }, zones?: {...} }
 * Los hijos anidados viajan como arrays DENTRO de props (slots). `zones` es un
 * vestigio legacy que se preserva verbatim cuando no puede normalizarse (fail-soft,
 * nunca throw, nunca pérdida). Cualquier cambio aquí exige pasar el gate de
 * round-trip sobre el corpus de producción (verso-roundtrip.test.ts).
 */

/**
 * Clave meta de almacenamiento. **SE QUEDA `_puck_data` A PROPÓSITO** — excepción única y ratificada
 * del renombrado (2026-08-15).
 *
 * El editor pasó a llamarse Verso y con él todos los módulos, ficheros y clases CSS. Esta clave NO,
 * porque no es un nombre de nuestro código: es un VALOR ya escrito en la tabla `postmeta` de cada
 * instalación que existe ahí fuera y en cada export WXR que se haya sacado de una. Renombrarla exigiría
 * una migración de datos cuyo modo de fallo es perder el cuerpo de todas las páginas hechas con
 * bloques, a cambio de estética. No hay ganancia que justifique ese riesgo.
 *
 * Léela como «el blob del documento del editor», no como una referencia al motor retirado.
 * El espejo de esta constante en el lado del guardado es `EDITOR_DATA_META_KEY`
 * (frontend/src/lib/editorGuards.ts), con la misma decisión documentada.
 */
export const CONTENT_META_KEY = "_puck_data";

/** Id del pseudo-nodo raíz en el documento normalizado. */
export const ROOT_ID = "verso:root";

/** Slot implícito de la raíz: el array `content` del formato persistido. */
export const ROOT_SLOT = "content";

/** Un bloque tal como se persiste. `props.id` es estable, generado una vez al insertar. */
export interface VersoItem {
  type: string;
  props: { id: string } & Record<string, unknown>;
}

/** Forma persistida completa (idéntica al `Data` de Puck v0.20 que leen las rutas públicas). */
export interface VersoData {
  content: VersoItem[];
  root: { props?: Record<string, unknown> } & Record<string, unknown>;
  /** Legacy. Clave = `${nodeId}:${slotName}`. Se normaliza si el destino existe; si no, se preserva. */
  zones?: Record<string, VersoItem[]>;
}

/** Nodo del documento normalizado. */
export interface VersoNode {
  /** Igual a props.id salvo colisión (dato corrupto): entonces clave interna desambiguada. */
  id: string;
  type: string;
  /**
   * Claves desconocidas a nivel de item (p.ej. `readOnly` de versiones de Puck).
   * Se preservan verbatim en la serialización — fail-soft, jamás se descartan.
   */
  extras?: Record<string, unknown>;
  /**
   * Props del bloque SIN los arrays de slot (extraídos a `slots`). El orden de
   * claves original del item — con los slots intercalados en su posición — se
   * conserva en `keyOrder`; la serialización emite en ese orden para que el
   * round-trip sea exacto (byte-a-byte, no solo deep-equal).
   */
  props: { id: string } & Record<string, unknown>;
  /**
   * `Object.keys(item.props)` del item original al internear. Solo se materializa
   * cuando el item tiene ≥1 slot (sin slots, el orden de `props` ya es el original).
   * La serialización emite estas claves en orden (slot reconstruido si está en
   * `slots`, prop si está en `props`), luego props nuevas y slots nuevos.
   */
  keyOrder?: string[];
  /** Ids de hijos por clave de slot, en orden. Solo claves detectadas como slot. */
  slots: Record<string, string[]>;
  /** Padre (ROOT_ID para los de primer nivel). */
  parentId: string;
  /** Slot del padre en el que vive este nodo. */
  slotKey: string;
  /** Índice dentro de ese slot. */
  index: number;
}

/**
 * Documento normalizado: mapa plano id→nodo + raíz. Habilita suscripción por nodo,
 * historia O(cambio) y resolución DnD sin recorrer el árbol.
 */
export interface VersoDoc {
  /** Nodos indexados por id interno (== props.id salvo duplicados corruptos). */
  nodes: Record<string, VersoNode>;
  /** Hijos de la raíz (slot ROOT_SLOT), en orden. */
  rootChildren: string[];
  /** El objeto `root` persistido, verbatim (props del documento: título, plantilla, etc.). */
  root: VersoData["root"];
  /**
   * Zonas legacy que NO pudieron normalizarse (nodo destino inexistente o slot no
   * declarado). Se serializan de vuelta VERBATIM — política fail-soft ratificada:
   * lo no entendido se preserva, jamás se descarta ni se lanza.
   */
  orphanZones: Record<string, VersoItem[]>;
  /** true si el dato original traía la clave `zones` (aunque fuera {}): se re-emite. */
  zonesKeyPresent: boolean;
  /**
   * Estado de la clave `content` en el original: 'array' normal, 'absent' (revisiones
   * reales de producción la omiten — docs 147/149/151 del corpus) o 'verbatim'
   * (presente pero no-array: preservada en extras). Los hijos reales siempre ganan.
   */
  contentKeyState: "array" | "absent" | "verbatim";
  /** true si el dato original traía la clave `root`. Se re-emite si estaba o si hay props. */
  rootKeyPresent: boolean;
  /**
   * Orden ORIGINAL de las claves top-level (docs reales guardan `root` antes que
   * `content`): la serialización lo respeta byte-a-byte; claves nuevas al final.
   */
  topKeyOrder: string[];
  /** Claves top-level desconocidas del dato original, re-emitidas verbatim. */
  extras: Record<string, unknown>;
  /** Anomalías no destructivas detectadas al normalizar (ids duplicados, zonas huérfanas…). */
  warnings: string[];
}

/**
 * Resolutor de slots: decide si `propKey` de un bloque `type` es un slot.
 * `undefined` = tipo desconocido para el registry → se aplica detección estructural.
 * Mantiene `normalize.ts` independiente del registry completo.
 */
export type SlotResolver = (type: string, propKey: string) => boolean | undefined;

/* ------------------------------------------------------------------ */
/* Comandos: única vía de escritura del documento.                     */
/* El DnD y toda la UI SOLO emiten comandos — jamás mutan (invariante  */
/* con test propio): un fallo de geometría no puede corromper datos.   */
/* ------------------------------------------------------------------ */

export interface InsertNodeCommand {
  kind: "insertNode";
  item: VersoItem;
  parentId: string;
  slotKey: string;
  index: number;
}

export interface MoveNodeCommand {
  kind: "moveNode";
  nodeId: string;
  toParentId: string;
  toSlotKey: string;
  toIndex: number;
}

export interface RemoveNodeCommand {
  kind: "removeNode";
  nodeId: string;
}

export interface SetPropsCommand {
  kind: "setProps";
  nodeId: string;
  /** Merge superficial; un valor `undefined` elimina la clave. `id` es inmutable. */
  patch: Record<string, unknown>;
}

export interface SetRootPropsCommand {
  kind: "setRootProps";
  patch: Record<string, unknown>;
}

export interface DuplicateSubtreeCommand {
  kind: "duplicateSubtree";
  nodeId: string;
  /** Ids frescos generados por el llamador (determinismo en tests y en colaboración futura). */
  idMap?: Record<string, string>;
}

/** Sustitución completa del documento (import JSON, plantillas). Explícita, nunca implícita. */
export interface ReplaceDataCommand {
  kind: "replaceData";
  data: VersoData;
}

export type VersoCommand =
  | InsertNodeCommand
  | MoveNodeCommand
  | RemoveNodeCommand
  | SetPropsCommand
  | SetRootPropsCommand
  | DuplicateSubtreeCommand
  | ReplaceDataCommand;

/* ------------------------------------------------------------------ */
/* Historia transaccional por parches inversos.                        */
/* ------------------------------------------------------------------ */

/**
 * Comando INTERNO de historia — no forma parte de `VersoCommand` ni del API de
 * `transact`: publica `doc` verbatim. Lo generan los inversos que no son
 * invertibles clave-a-clave (replaceData; setRootProps sobre un root sin props):
 * restaurar el doc por referencia (en vez de re-normalizar una serialización)
 * preserva metadatos de forma no serializables — p.ej. contentKeyState "absent" —
 * y hace el inverso EXACTO también a nivel de doc.
 */
export interface RestoreDocCommand {
  kind: "history:restoreDoc";
  doc: VersoDoc;
}

/** Lo que puede contener la historia: los comandos públicos más el interno de restauración. */
export type VersoHistoryCommand = VersoCommand | RestoreDocCommand;

export interface HistoryEntry {
  /** Comandos aplicados, en orden. */
  commands: VersoHistoryCommand[];
  /** Inversos exactos en orden CRONOLÓGICO; deshacer = aplicarlos en orden inverso. */
  inverse: VersoHistoryCommand[];
  /** Marca de coalescencia: transacciones contiguas con la misma clave dentro de la ventana se funden. */
  coalesceKey?: string;
  /** Etiqueta legible para UI de historia (opcional; aditivo F2). */
  label?: string;
  at: number;
}

/** Selección actual del editor. */
export interface VersoSelection {
  nodeId: string | null;
}

export interface VersoEditorState {
  doc: VersoDoc;
  selection: VersoSelection;
  /** Id del bloque en edición inline activa (sustituye a window.puckActiveEditorId). */
  inlineEditingId: string | null;
  /** Preview optimista durante un drag (el documento NO se muta hasta el drop). */
  dragPreview: DragPreview | null;
}

export interface DragPreview {
  source: { kind: "existing"; nodeId: string } | { kind: "new"; type: string };
  targetParentId: string;
  targetSlotKey: string;
  targetIndex: number;
}
