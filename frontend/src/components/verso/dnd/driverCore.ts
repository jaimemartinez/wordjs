/**
 * Verso DnD — núcleo PURO del driver de sensores (sin React, sin DOM).
 *
 * Todo lo que el driver necesita computar por tick vive aquí como funciones
 * puras o trackers con estado propio POR SESIÓN (nunca module-level: la trampa
 * F-5 de la spec — estado global compartido entre drags — se evita a propósito):
 * traducción de coordenadas padre→iframe, dirección de movimiento con la
 * histéresis de 10px (spec §3.2), el tracker de "origen pegajoso"
 * (originApproaching, spec §3.4.1), la construcción del ResolveDragInput desde
 * el doc + geometría medida, el movimiento por teclado y el autoscroll.
 *
 * INVARIANTE Verso: nada de este módulo toca el documento — solo produce
 * entradas para `resolveDragTarget` y objetivos para comandos que emite la capa
 * de sesión (session.ts) vía transact.
 */

import { ROOT_ID, ROOT_SLOT, type VersoDoc, type VersoNode } from "@/lib/verso/types";
import type { BlockRegistry, SlotVersoField } from "@/lib/verso/registry";
import type {
  ComponentGeom,
  DndDirection,
  DndPoint,
  DndRect,
  TextDir,
  ZoneFlow,
  ZoneGeom,
} from "@/lib/verso/dnd/types";
import { ROOT_DROPPABLE_ID } from "@/lib/verso/dnd/resolve";
import type { BlockRect } from "../overlay/GeometryStore";
// Tipo SOLO: `session.ts` importa este módulo, así que un import de valor sería un ciclo. Un
// `import type` se borra al compilar, de modo que en tiempo de ejecución la dependencia sigue
// siendo en un solo sentido.
import type { DragSource } from "./session";

/** Umbral de activación del drag: 5px desde el pointerdown (spec §5, caso "other"). */
export const DRAG_START_THRESHOLD = 5;

/** Histéresis del trackeo de movimiento/origen: el punto de referencia solo avanza con deltas >10px (spec §0 INTERVAL_SENSITIVITY, §3.4.1). */
export const TRACK_SENSITIVITY = 10;

/** Ventana post-cambio-de-zona con el fallback por proximidad deshabilitado (spec §2). */
export const FALLBACK_DISABLE_MS = 100;

/** Proximidad al borde del viewport del iframe que activa el autoscroll. */
export const AUTOSCROLL_EDGE = 150;

/** Velocidad máxima del autoscroll (px por frame, proporcional a la proximidad). */
export const AUTOSCROLL_MAX_SPEED = 24;

/** Bounding box sintético del "clon" de un item NUEVO (no hay clon visual todavía). */
export const NEW_DRAG_WIDTH = 200;
export const NEW_DRAG_HEIGHT = 48;

/* ------------------------------------------------------------------ */
/* Coordenadas                                                          */
/* ------------------------------------------------------------------ */

/**
 * Traduce un punto del documento PADRE (clientX/Y) al sistema del iframe:
 * resta el offset del iframe y divide por la escala del device-preview
 * (rect visual / tamaño CSS real). Los eventos originados DENTRO del iframe
 * ya están en este sistema y no pasan por aquí.
 */
export function translateParentPoint(
  clientX: number,
  clientY: number,
  frameOffset: { left: number; top: number },
  scale: number,
): DndPoint {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: (clientX - frameOffset.left) / s, y: (clientY - frameOffset.top) / s };
}

export function blockRectToDndRect(r: BlockRect): DndRect {
  return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
}

/**
 * Escala visual del iframe derivada de su propia caja: rect.width (px visuales
 * de getBoundingClientRect en el PADRE) / clientWidth (px CSS del iframe). Con
 * el device-preview (`transform: scale(s)` en el contenedor) esta fórmula
 * sigue siendo EXACTA por definición: un transform no altera clientWidth
 * (layout interno) y getBoundingClientRect devuelve la caja post-transform,
 * o sea clientWidth·s — el cociente ES s. clientWidth 0 (iframe sin layout)
 * → 1, fail-soft.
 */
export function frameScaleOf(rectWidth: number, clientWidth: number): number {
  return clientWidth > 0 ? rectWidth / clientWidth : 1;
}

/** Forma mínima de la caja del iframe que necesita toFramePoint. */
export interface FrameBox {
  left: number;
  top: number;
  /** rect.width visual (post-transform) del iframe. */
  width: number;
  /** clientWidth CSS (pre-transform) del iframe. */
  clientWidth: number;
}

/**
 * Punto del documento PADRE (clientX/Y) → coordenadas del iframe, con la
 * escala derivada de la caja (frameScaleOf). Pura — es exactamente lo que el
 * driver hace por tick con eventos del padre; extraída para testear la
 * aritmética con escala != 1 (0.75 del device-preview) sin DOM.
 */
export function toFramePoint(clientX: number, clientY: number, box: FrameBox): DndPoint {
  return translateParentPoint(
    clientX,
    clientY,
    { left: box.left, top: box.top },
    frameScaleOf(box.width, box.clientWidth),
  );
}

/** Rect del "clon" arrastrado: el bloque de origen desplazado, o la caja sintética del item nuevo. */
export function dragRectFor(
  originRect: DndRect | null,
  start: DndPoint,
  current: DndPoint,
): DndRect {
  if (originRect) {
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    return {
      left: originRect.left + dx,
      top: originRect.top + dy,
      right: originRect.right + dx,
      bottom: originRect.bottom + dy,
    };
  }
  return {
    left: current.x - NEW_DRAG_WIDTH / 2,
    top: current.y - NEW_DRAG_HEIGHT / 2,
    right: current.x + NEW_DRAG_WIDTH / 2,
    bottom: current.y + NEW_DRAG_HEIGHT / 2,
  };
}

/* ------------------------------------------------------------------ */
/* Trackers por sesión (spec §3.2 y §3.4.1)                             */
/* ------------------------------------------------------------------ */

export interface DirectionTracker {
  /** Dirección vigente tras registrar el punto. `null` solo antes de cualquier movimiento (F-7). */
  update(p: DndPoint): DndDirection;
}

/**
 * Deriva la dirección de movimiento: delta contra el último punto "asentado"
 * (que solo avanza cuando |delta| supera TRACK_SENSITIVITY — la histéresis que
 * evita que la dirección tiemble con jitter). Empate exacto |dy|===|dx| cae en
 * el eje X (F-6, `>` estricto); delta cero conserva la dirección previa.
 */
export function createDirectionTracker(): DirectionTracker {
  let prev: DndPoint | null = null;
  let direction: DndDirection = null;
  return {
    update(p: DndPoint): DndDirection {
      if (prev === null) {
        prev = p;
        return direction;
      }
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      let next: DndDirection = null;
      if (Math.abs(dy) > Math.abs(dx)) next = dy > 0 ? "down" : dy < 0 ? "up" : null;
      else next = dx > 0 ? "right" : dx < 0 ? "left" : null;
      if (next !== null) direction = next;
      if (Math.abs(dx) > TRACK_SENSITIVITY || Math.abs(dy) > TRACK_SENSITIVITY) prev = p;
      return direction;
    },
  };
}

export interface OriginTracker {
  /**
   * ¿La distancia del puntero al centro del rect de ORIGEN decrece respecto al
   * último punto asentado? `undefined` hasta el primer movimiento registrado;
   * distancia exactamente igual conserva el estado previo (spec §3.4.1).
   */
  update(p: DndPoint): boolean | undefined;
}

export function createOriginTracker(originRect: DndRect): OriginTracker {
  const center: DndPoint = {
    x: (originRect.left + originRect.right) / 2,
    y: (originRect.top + originRect.bottom) / 2,
  };
  let prev: DndPoint | null = null;
  let approaching: boolean | undefined;
  return {
    update(p: DndPoint): boolean | undefined {
      if (prev === null) {
        prev = p;
        return approaching;
      }
      const dPrev = Math.hypot(prev.x - center.x, prev.y - center.y);
      const dCur = Math.hypot(p.x - center.x, p.y - center.y);
      if (dCur < dPrev) approaching = true;
      else if (dCur > dPrev) approaching = false;
      if (Math.hypot(p.x - prev.x, p.y - prev.y) > TRACK_SENSITIVITY) prev = p;
      return approaching;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ids de zona: (parentId, slotKey) ↔ zoneCompound del resolutor        */
/* ------------------------------------------------------------------ */

/** Atributo `data-wjs-slot` que estampa VersoSlot: `${parentId}:${slotKey}` (raíz incluida). */
export function slotAttrValue(parentId: string, slotKey: string): string {
  return `${parentId}:${slotKey}`;
}

/**
 * Id de zona que consume el resolutor. La raíz usa el literal del fork
 * (`root:default-zone`, ROOT_DROPPABLE_ID) para que sus fallbacks a raíz
 * (§1.1 drawer, §1.3 cero candidatos) resuelvan a una zona existente.
 */
export function zoneIdFor(parentId: string, slotKey: string): string {
  if (parentId === ROOT_ID && slotKey === ROOT_SLOT) return ROOT_DROPPABLE_ID;
  return `${parentId}:${slotKey}`;
}

/** Inversa de zoneIdFor: destino (parentId, slotKey) de un slotId resuelto. */
export function parseZoneId(zoneId: string): { parentId: string; slotKey: string } {
  if (zoneId === ROOT_DROPPABLE_ID) return { parentId: ROOT_ID, slotKey: ROOT_SLOT };
  const sep = zoneId.indexOf(":");
  if (sep === -1) return { parentId: zoneId, slotKey: "" };
  return { parentId: zoneId.slice(0, sep), slotKey: zoneId.slice(sep + 1) };
}

/* ------------------------------------------------------------------ */
/* Construcción del layout (ResolveDragInput.layout)                    */
/* ------------------------------------------------------------------ */

/** Geometría + estilo computado (cacheado) del elemento de un slot visible. */
export interface SlotInfo {
  rect: DndRect;
  /** display/flexDirection computados → eje de arrastre (spec §3.1). */
  flow: ZoneFlow;
  /** dir efectivo del computedStyle del elemento del slot (spec §3.6). */
  dir: TextDir;
}

export interface DragLayoutSources {
  doc: VersoDoc;
  registry: BlockRegistry;
  /** Rect medido (GeometryStore) de un bloque por su clave interna; null = sin medir (se omite). */
  getBlockRect(id: string): DndRect | null;
  /** Rect + estilo del elemento de un slot; null = slot no visible/no montado (se omite). */
  getSlotInfo(parentId: string, slotKey: string): SlotInfo | null;
}

function slotFieldOf(registry: BlockRegistry, parentType: string | undefined, slotKey: string): SlotVersoField | null {
  if (!parentType) return null;
  const field = registry.get(parentType)?.fields[slotKey];
  return field && field.type === "slot" ? field : null;
}

function buildZone(
  src: DragLayoutSources,
  parentId: string,
  slotKey: string,
  info: SlotInfo,
  depth: number,
  childIds: readonly string[],
): ZoneGeom {
  const parentNode: VersoNode | undefined = parentId === ROOT_ID ? undefined : src.doc.nodes[parentId];
  const field = slotFieldOf(src.registry, parentNode?.type, slotKey);
  const items: ComponentGeom[] = [];
  for (const childId of childIds) {
    const node = src.doc.nodes[childId];
    if (!node) continue;
    const rect = src.getBlockRect(childId);
    if (!rect) continue; // fail-soft: bloque sin geometría medida no participa este tick
    const zones: ZoneGeom[] = [];
    for (const [k, ids] of Object.entries(node.slots)) {
      const slotInfo = src.getSlotInfo(childId, k);
      if (!slotInfo) continue;
      zones.push(buildZone(src, childId, k, slotInfo, depth + 2, ids));
    }
    items.push({
      id: childId,
      kind: "component",
      componentType: node.type,
      depth: depth + 1, // +1 por frontera zona→componente (spec §0)
      rect,
      zones,
    });
  }
  const zone: ZoneGeom = {
    id: zoneIdFor(parentId, slotKey),
    kind: "zone",
    areaId: parentId === ROOT_ID ? "root" : parentId,
    depth,
    direction: info.flow,
    dir: info.dir,
    accepts: field?.allow ?? null,
    rect: info.rect,
    items,
  };
  if (field?.disallow) zone.disallow = field.disallow;
  return zone;
}

/**
 * Árbol de zonas para `resolveDragTarget` desde el doc + geometría medida.
 * `null` si la zona raíz no está montada/medida (canvas sin listo): la sesión
 * simplemente no actualiza el preview ese tick.
 */
export function buildDragLayout(src: DragLayoutSources): ZoneGeom | null {
  const rootInfo = src.getSlotInfo(ROOT_ID, ROOT_SLOT);
  if (!rootInfo) return null;
  return buildZone(src, ROOT_ID, ROOT_SLOT, rootInfo, 0, src.doc.rootChildren);
}

/* ------------------------------------------------------------------ */
/* Autoscroll                                                           */
/* ------------------------------------------------------------------ */

/**
 * Velocidad de autoscroll (px/frame) proporcional a la proximidad del puntero
 * a los bordes del viewport del iframe; {0,0} fuera de la franja de 150px.
 */
export function autoscrollVelocity(
  p: DndPoint,
  viewport: { width: number; height: number },
  edge: number = AUTOSCROLL_EDGE,
  maxSpeed: number = AUTOSCROLL_MAX_SPEED,
): { x: number; y: number } {
  const axis = (pos: number, size: number): number => {
    if (pos < edge) return -Math.min(1, (edge - pos) / edge) * maxSpeed;
    if (pos > size - edge) return Math.min(1, (pos - (size - edge)) / edge) * maxSpeed;
    return 0;
  };
  return { x: axis(p.x, viewport.width), y: axis(p.y, viewport.height) };
}

/* ------------------------------------------------------------------ */
/* Movimiento por teclado                                               */
/* ------------------------------------------------------------------ */

export type KeyboardMoveDirection = "up" | "down" | "left" | "right";

export interface KeyboardMoveTarget {
  toParentId: string;
  toSlotKey: string;
  /** Índice POST-remoción, la semántica exacta de moveNode (commands.ts). */
  toIndex: number;
}

/** allow/disallow de un slot declarado, con la semántica exacta del fork (spec §1.5). */
export function slotFieldAccepts(field: SlotVersoField | null, componentType: string): boolean {
  if (!field) return true; // slot sin declaración en el registry: sin opinión = acepta
  const allow = field.allow ?? null;
  const disallow = field.disallow;
  if (disallow) {
    const filtered = disallow.filter((t) => !(allow ?? []).includes(t));
    if (filtered.includes(componentType)) return false;
  } else if (allow) {
    if (!allow.includes(componentType)) return false;
  }
  return true;
}

function siblingsOf(doc: VersoDoc, node: VersoNode): readonly string[] {
  if (node.parentId === ROOT_ID) return doc.rootChildren;
  return doc.nodes[node.parentId]?.slots[node.slotKey] ?? [];
}

/**
 * Destino del movimiento por teclado (mismo comando moveNode que el drop):
 * - up/down: hermano anterior/siguiente dentro del mismo slot (índice post-remoción).
 * - left: SALIR al slot del padre, justo después del contenedor. En raíz → null.
 * - right: ENTRAR al slot de un hermano adyacente (el anterior primero — al
 *   final de su slot —, si no el siguiente — a su posición 0), respetando
 *   allow/disallow. Solo slots ya materializados en node.slots.
 */
export function keyboardMoveTarget(
  doc: VersoDoc,
  registry: BlockRegistry,
  nodeId: string,
  dir: KeyboardMoveDirection,
): KeyboardMoveTarget | null {
  const node = doc.nodes[nodeId];
  if (!node) return null;
  const siblings = siblingsOf(doc, node);
  const index = siblings.indexOf(nodeId);
  if (index === -1) return null;

  if (dir === "up") {
    return index > 0 ? { toParentId: node.parentId, toSlotKey: node.slotKey, toIndex: index - 1 } : null;
  }
  if (dir === "down") {
    return index < siblings.length - 1
      ? { toParentId: node.parentId, toSlotKey: node.slotKey, toIndex: index + 1 }
      : null;
  }
  if (dir === "left") {
    if (node.parentId === ROOT_ID) return null;
    const parent = doc.nodes[node.parentId];
    if (!parent) return null;
    return { toParentId: parent.parentId, toSlotKey: parent.slotKey, toIndex: parent.index + 1 };
  }
  // "right": hermano adyacente con slot que acepte el tipo.
  const candidates: Array<{ sibId: string | undefined; atEnd: boolean }> = [
    { sibId: siblings[index - 1], atEnd: true },
    { sibId: siblings[index + 1], atEnd: false },
  ];
  for (const { sibId, atEnd } of candidates) {
    if (!sibId) continue;
    const sib = doc.nodes[sibId];
    if (!sib) continue;
    const slotKey = Object.keys(sib.slots)[0];
    if (!slotKey) continue;
    if (!slotFieldAccepts(slotFieldOf(registry, sib.type, slotKey), node.type)) continue;
    const len = sib.slots[slotKey]?.length ?? 0;
    return { toParentId: sibId, toSlotKey: slotKey, toIndex: atEnd ? len : 0 };
  }
  return null;
}

/** Texto del anuncio aria-live tras un movimiento: "<type> movido a <slot> posición <n>". */
export function moveAnnouncement(
  doc: VersoDoc,
  registry: BlockRegistry,
  nodeId: string,
  target: KeyboardMoveTarget,
): string {
  const node = doc.nodes[nodeId];
  const typeLabel = node ? (registry.get(node.type)?.label ?? node.type) : nodeId;
  let slotLabel = "raíz";
  if (target.toParentId !== ROOT_ID) {
    const parent = doc.nodes[target.toParentId];
    const parentLabel = parent ? (registry.get(parent.type)?.label ?? parent.type) : target.toParentId;
    slotLabel = `${parentLabel} › ${target.toSlotKey}`;
  }
  return `${typeLabel} movido a ${slotLabel} posición ${target.toIndex + 1}`;
}

/* ------------------------------------------------------------------ */
/* Modo mover por teclado (controlador puro, testeable sin DOM)         */
/* ------------------------------------------------------------------ */

/** Forma mínima de un KeyboardEvent que el controlador necesita. */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface KeyboardMoverDeps {
  /** Lecturas del estado + transact. Estructural: el EditorHandle real encaja. */
  handle: {
    getDoc(): VersoDoc;
    getState(): { selection: { nodeId: string | null } };
    transact(
      fn: (tx: { moveNode(nodeId: string, toParentId: string, toSlotKey: string, toIndex: number): void }) => void,
      opts?: { label?: string },
    ): boolean;
  };
  registry: BlockRegistry;
  /** Canal del live-region del overlay. */
  announce(message: string): void;
}

export interface KeyboardMover {
  /** true si el evento fue consumido (la capa DOM hace preventDefault). */
  handleKey(e: KeyLike): boolean;
  isMoveMode(): boolean;
}

function arrowToDirection(key: string): KeyboardMoveDirection | null {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    default:
      return null;
  }
}

/**
 * Modo mover de primera clase: `M` (con un bloque seleccionado) entra en modo
 * mover; en modo mover las flechas ejecutan moveNode; `Ctrl/Cmd+Shift+Flecha`
 * entra Y ejecuta de una vez; `Escape` sale del modo. Cada movimiento anuncia
 * en el live-region. El controlador solo emite comandos vía transact — jamás
 * toca el doc por otra vía.
 */
export function createKeyboardMover(deps: KeyboardMoverDeps): KeyboardMover {
  let moveMode = false;

  const execute = (nodeId: string, dir: KeyboardMoveDirection): boolean => {
    const target = keyboardMoveTarget(deps.handle.getDoc(), deps.registry, nodeId, dir);
    if (!target) return false;
    const ok = deps.handle.transact(
      (tx) => tx.moveNode(nodeId, target.toParentId, target.toSlotKey, target.toIndex),
      { label: "Mover bloque (teclado)" },
    );
    if (ok) deps.announce(moveAnnouncement(deps.handle.getDoc(), deps.registry, nodeId, target));
    return ok;
  };

  return {
    isMoveMode: () => moveMode,
    handleKey(e: KeyLike): boolean {
      if (e.key === "Escape") {
        if (!moveMode) return false;
        moveMode = false;
        deps.announce("Modo mover desactivado");
        return true;
      }
      const selected = deps.handle.getState().selection.nodeId;
      const dir = arrowToDirection(e.key);
      if (dir && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        if (!selected) return false;
        moveMode = true;
        execute(selected, dir);
        return true;
      }
      if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!selected) return false;
        moveMode = true;
        deps.announce("Modo mover: usa las flechas para mover el bloque, Escape para salir");
        return true;
      }
      if (moveMode && dir && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!selected) {
          moveMode = false;
          return false;
        }
        execute(selected, dir);
        return true;
      }
      return false;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Máquina del GESTO de puntero                                        */
/* ------------------------------------------------------------------ */

/**
 * EL GESTO, sin DOM: pulsar, mover, soltar — y la única pregunta que decide si hubo arrastre.
 *
 * Vivía dentro del `useEffect` del driver, mezclado con el cableado de eventos, y por eso ningún
 * test lo veía. El defecto que eso escondía se midió en el navegador: los ticks de movimiento se
 * agrupan por fotograma (rAF), así que un gesto rápido —pulsar, mover y soltar dentro del MISMO
 * fotograma— llegaba al `up` con la sesión todavía sin crear y el arrastre se descartaba EN
 * SILENCIO. Es decir: que un arrastre contara dependía de si por casualidad había pasado un
 * fotograma, no de lo que hizo la persona. Y aun con la sesión creada, soltar justo después del
 * último ajuste dejaba caer el bloque donde estaba el puntero un fotograma ANTES, porque el drop
 * lee el preview que solo escribe un `move` ya aplicado.
 *
 * Aquí el `up` VACÍA la cola con el último punto real antes de soltar, así que la decisión es
 * siempre la distancia recorrida. El agrupado por fotograma se conserva para lo que existe: no
 * recalcular la geometría en cada uno de los cientos de `pointermove` de un arrastre.
 *
 * `S` es la sesión (opaca aquí): el driver inyecta cómo crearla, moverla, soltarla y cancelarla,
 * y el planificador de fotogramas. Ambos son las costuras que hacen esto probable en node.
 */
export interface PointerGestureDeps<S> {
  createSession(source: DragSource, start: DndPoint): S;
  moveSession(session: S, point: DndPoint, overDrawer: boolean): void;
  dropSession(session: S): void;
  cancelSession(session: S): void;
  /** Agrupa el trabajo por fotograma (rAF). Devuelve el id que `cancelFrame` cancela. */
  scheduleFrame(cb: () => void): number;
  cancelFrame(id: number): void;
  /** Se llama UNA vez, cuando el gesto pasa a ser un arrastre de verdad. */
  onSessionStart?(): void;
}

export interface PointerGesture {
  /** Pulsación sobre un origen arrastrable. Todavía NO es un arrastre: eso lo dice la distancia. */
  down(source: DragSource, start: DndPoint): void;
  move(point: DndPoint, overDrawer?: boolean): void;
  /** Soltar: aplica lo pendiente y suelta si hubo arrastre. Un tap (<umbral) no suelta nada. */
  up(): void;
  /** Escape: cancela sin tocar el documento. */
  cancel(): void;
  /** ¿Hay un arrastre vivo? Lo usa el autoscroll, que solo corre mientras lo haya. */
  active(): boolean;
  /**
   * ¿Hay un dedo puesto sobre algo arrastrable? Cierto DESDE el `down`, antes de saber si habrá
   * arrastre. Es lo que decide si se le quita al navegador su selección de texto: esperar a
   * `active()` llegaría tarde — para entonces ya hay medio párrafo en azul.
   */
  armed(): boolean;
  /** Último punto conocido, en coordenadas del iframe. */
  point(): DndPoint | null;
}

export function createPointerGesture<S>(deps: PointerGestureDeps<S>): PointerGesture {
  let pending: { source: DragSource; start: DndPoint } | null = null;
  let session: S | null = null;
  let last: DndPoint | null = null;
  let overDrawer = false;
  let raf: number | null = null;

  /** Aplica el último punto: crea la sesión si el gesto ya superó el umbral, y la mueve. */
  const flush = (): void => {
    if (raf !== null) {
      deps.cancelFrame(raf);
      raf = null;
    }
    if (!last) return;
    if (!session && pending) {
      const d = Math.hypot(last.x - pending.start.x, last.y - pending.start.y);
      if (d < DRAG_START_THRESHOLD) return; // sigue siendo un tap
      session = deps.createSession(pending.source, pending.start);
      pending = null;
      deps.onSessionStart?.();
    }
    if (session) deps.moveSession(session, last, overDrawer);
  };

  const reset = (): void => {
    if (raf !== null) {
      deps.cancelFrame(raf);
      raf = null;
    }
    pending = null;
    session = null;
    last = null;
    overDrawer = false;
  };

  return {
    down(source, start) {
      reset();
      pending = { source, start };
    },
    move(point, over = false) {
      if (!pending && !session) return;
      last = point;
      overDrawer = over;
      if (raf === null) raf = deps.scheduleFrame(() => { raf = null; flush(); });
    },
    up() {
      flush();
      if (session) deps.dropSession(session);
      reset();
    },
    cancel() {
      if (session) deps.cancelSession(session);
      reset();
    },
    active() {
      return session !== null;
    },
    armed() {
      return session !== null || pending !== null;
    },
    point() {
      return last;
    },
  };
}
