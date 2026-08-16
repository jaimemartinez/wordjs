/**
 * Verso DnD — sesión de arrastre: estado por-drag y traducción de ticks de
 * puntero a `setDragPreview`, y del drop a UNA transacción.
 *
 * INVARIANTE (con test propio en __tests__/dndDriver.test.ts): la sesión JAMÁS
 * toca el documento fuera de la única `transact` del drop — los moves solo
 * llaman `resolveDragTarget` (puro) y `setDragPreview` (estado de UI, no doc);
 * `cancel()` solo limpia el preview. Un fallo de geometría no puede corromper
 * datos por construcción.
 *
 * Estado por-sesión, nunca module-level (evita la trampa F-5 de la spec):
 * trackers de dirección y de origen, último slot resuelto (para la ventana de
 * 100ms sin fallback tras cambiar de zona, spec §2) y el punto de arranque.
 */

import type { DragPreview, VersoItem } from "@/lib/verso/types";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import type { DndPoint, DndRect, ZoneGeom } from "@/lib/verso/dnd/types";
import { resolveDragTarget } from "@/lib/verso/dnd/resolve";
import {
  FALLBACK_DISABLE_MS,
  createDirectionTracker,
  createOriginTracker,
  dragRectFor,
  parseZoneId,
} from "./driverCore";

/** Origen del drag: bloque existente del canvas o item nuevo de la paleta. */
export type DragSource =
  | { kind: "existing"; nodeId: string; originRect: DndRect | null }
  | { kind: "new"; type: string };

export interface DragSessionDeps {
  handle: EditorHandle;
  registry: BlockRegistry;
  /** Layout vigente (buildDragLayout); null = sin geometría este tick (no-op). */
  getLayout(): ZoneGeom | null;
  /** Reloj inyectable para la ventana de fallback (tests). Default: Date.now. */
  now?: () => number;
  /** Ids frescos para el insertNode del drop. Default: crypto.randomUUID. */
  generateId?: () => string;
}

export interface MoveOptions {
  /** true = el puntero está sobre la paleta del documento padre (spec §1.1 paso 2). */
  pointerOverDrawer?: boolean;
}

export interface DragSession {
  /** Un tick de movimiento (ya throttled por rAF en la capa DOM), en coordenadas del iframe. */
  move(point: DndPoint, opts?: MoveOptions): void;
  /** Consuma el drop: UNA transacción con el destino del preview vigente; limpia el preview. */
  drop(): boolean;
  /** Cancela: SOLO limpia el preview — el doc queda intacto. */
  cancel(): void;
}

function defaultGenerateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `verso-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDragSession(
  deps: DragSessionDeps,
  source: DragSource,
  startPoint: DndPoint,
): DragSession {
  const now = deps.now ?? (() => Date.now());
  const directionTracker = createDirectionTracker();
  const originTracker =
    source.kind === "existing" && source.originRect ? createOriginTracker(source.originRect) : null;
  const originRect = source.kind === "existing" ? source.originRect : null;
  let lastSlotId: string | null = null;
  /** -Infinity: al arrancar la sesión el fallback está habilitado (estado estable). */
  let lastZoneChangeAt = Number.NEGATIVE_INFINITY;
  let finished = false;

  const previewSource: DragPreview["source"] =
    source.kind === "existing" ? { kind: "existing", nodeId: source.nodeId } : { kind: "new", type: source.type };

  return {
    move(point: DndPoint, opts: MoveOptions = {}): void {
      if (finished) return;
      const layout = deps.getLayout();
      if (!layout) return;
      const direction = directionTracker.update(point);
      const originApproaching = originTracker?.update(point);
      const target = resolveDragTarget({
        layout,
        pointer: point,
        dragging: {
          type: source.kind === "existing" ? "existing" : "new",
          sourceId: source.kind === "existing" ? source.nodeId : null,
          componentType:
            source.kind === "existing"
              ? (deps.handle.getDoc().nodes[source.nodeId]?.type ?? "")
              : source.type,
          rect: dragRectFor(originRect, startPoint, point),
          direction,
          fallbackEnabled: now() - lastZoneChangeAt > FALLBACK_DISABLE_MS,
          ...(originApproaching !== undefined ? { originApproaching } : {}),
        },
        pointerOverDrawer: opts.pointerOverDrawer,
      });
      // {null,null} = "no actualizar el preview este tick" (F-4, F-9, §3.5).
      if (target.slotId === null || target.index === null) return;
      if (target.slotId !== lastSlotId) {
        // Cambio de zona: abre la ventana de 100ms sin fallback (spec §2). El
        // primer slot resuelto de la sesión no cuenta como "cambio".
        if (lastSlotId !== null) lastZoneChangeAt = now();
        lastSlotId = target.slotId;
      }
      const { parentId, slotKey } = parseZoneId(target.slotId);
      const prev = deps.handle.getState().dragPreview;
      if (
        prev &&
        prev.targetParentId === parentId &&
        prev.targetSlotKey === slotKey &&
        prev.targetIndex === target.index
      ) {
        return; // preview idéntico: sin notificación vacía
      }
      deps.handle.setDragPreview({
        source: previewSource,
        targetParentId: parentId,
        targetSlotKey: slotKey,
        targetIndex: target.index,
      });
    },

    drop(): boolean {
      if (finished) return false;
      finished = true;
      const preview = deps.handle.getState().dragPreview;
      let ok = false;
      if (preview) {
        if (source.kind === "existing") {
          ok = deps.handle.transact(
            (tx) =>
              tx.moveNode(source.nodeId, preview.targetParentId, preview.targetSlotKey, preview.targetIndex),
            { label: "Mover bloque (drag)" },
          );
        } else {
          const def = deps.registry.get(source.type);
          if (def) {
            let defaults: Record<string, unknown>;
            try {
              defaults = structuredClone(def.defaultProps);
            } catch {
              defaults = { ...def.defaultProps };
            }
            const id = (deps.generateId ?? defaultGenerateId)();
            const item: VersoItem = { type: source.type, props: { ...defaults, id } };
            ok = deps.handle.transact(
              (tx) => tx.insertNode(item, preview.targetParentId, preview.targetSlotKey, preview.targetIndex),
              { label: `Insertar ${def.label ?? source.type}` },
            );
          }
        }
      }
      deps.handle.setDragPreview(null);
      return ok;
    },

    cancel(): void {
      if (finished) return;
      finished = true;
      // INVARIANTE: cancelar solo limpia el preview — jamás una transacción.
      deps.handle.setDragPreview(null);
    },
  };
}
