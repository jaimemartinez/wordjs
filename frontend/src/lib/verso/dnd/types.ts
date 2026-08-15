/**
 * Verso DnD — geometría abstracta del arrastre.
 *
 * CONTRATO: espeja 1:1 la forma del fixture ejecutable
 * `frontend/src/lib/verso/__fixtures__/dnd-cases.json` y la spec
 * `documentation/verso/dnd-spec.md`. Aquí no hay DOM: los rects llegan ya
 * resueltos (absolutos), `dir` es el resultado ya calculado de getDeepDir
 * (spec §3.6) y `direction` ya está derivada del movimiento (spec §3.2).
 */

export interface DndRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DndPoint {
  x: number;
  y: number;
}

/** Dirección de movimiento ya resuelta. `null` = primer tick sin movimiento (F-7). */
export type DndDirection = "up" | "down" | "left" | "right" | null;

/** Layout de la zona → eje de arrastre (spec §3.1): row→x, grid→dynamic, column→y. */
export type ZoneFlow = "column" | "row" | "grid";

export type TextDir = "ltr" | "rtl";

export interface ZoneGeom {
  /** zoneCompound: `${areaId}:${slot}` (p.ej. "root:default-zone", "CompA:content"). */
  id: string;
  kind: "zone";
  /** Id del componente dueño de la zona ("root" para la raíz). */
  areaId: string;
  /** Profundidad ya resuelta: +1 por cada frontera zona↔componente (spec §0). */
  depth: number;
  direction: ZoneFlow;
  /** Valor efectivo equivalente a getDeepDir — ya heredado/resuelto. */
  dir: TextDir;
  /** Allow-list; `null` = acepta todo tipo. Se combina con `disallow` según spec §1.5. */
  accepts: string[] | null;
  disallow?: string[];
  rect: DndRect;
  items: ComponentGeom[];
}

export interface ComponentGeom {
  id: string;
  kind: "component";
  componentType: string;
  depth: number;
  rect: DndRect;
  /** Solo en casos de solape: mayor = pintado más al frente. */
  zIndex?: number;
  /** Zonas anidadas propias; [] si es hoja. */
  zones: ZoneGeom[];
}

export interface DragGeom {
  /** "new" = desde el drawer; "existing" = reordenar/mover un nodo del canvas (spec §4). */
  type: "new" | "existing";
  /** Requerido si type==="existing"; el fixture manda null en los "new". */
  sourceId?: string | null;
  componentType: string;
  /** Bounding box ACTUAL del clon arrastrado (Fase 2, spec §3.3). */
  rect: DndRect;
  direction: DndDirection;
  /**
   * default true. `false` simula la ventana de 100ms post-cambio de zona/área en
   * la que el fallback por proximidad (closestCorners) está deshabilitado (spec §2).
   */
  fallbackEnabled?: boolean;
  /**
   * "Origen pegajoso" (spec §3.4.1): ¿la distancia del clon al centro de su
   * posición ORIGINAL está disminuyendo? La deriva el driver de sensores
   * trackeando el movimiento (como `direction`). Si viene definido, el origen
   * produce la colisión Highest SOLO cuando es `true`; si es `undefined`, el
   * resolutor usa el proxy puro pointInRect (divergencia documentada en la spec).
   */
  originApproaching?: boolean;
}

export interface ResolveDragInput {
  /** Árbol de zonas/ítems con rects absolutos (la zona raíz). */
  layout: ZoneGeom;
  /** Punto del puntero (Fase 1: hit-test + buffer de 6px). */
  pointer: DndPoint;
  dragging: DragGeom;
  /**
   * Orden elementsFromPoint (más al frente primero). Solo es determinante cuando
   * ≥2 candidatos comparten profundidad EXACTA bajo el puntero (F-2).
   */
  hitOrder?: string[];
  /**
   * true = el elemento bajo el puntero tiene [data-puck-drawer] (spec §1.1 paso 2):
   * la lista de candidatos queda vacía ⇒ fallback a rootDroppableId.
   */
  pointerOverDrawer?: boolean;
}

/** `null`/`null` = el motor NO debe actualizar el preview este tick (F-4, F-9, §3.5, §8.2-8.3). */
export interface DragTarget {
  slotId: string | null;
  index: number | null;
}
