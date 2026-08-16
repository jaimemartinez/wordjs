/**
 * Verso DnD — resolutor PURO de destino de arrastre.
 *
 * Réplica sin DOM del comportamiento observable del clúster DnD del fork
 * @wordjs/puck, según el contrato `documentation/verso/dnd-spec.md` y el fixture
 * `__fixtures__/dnd-cases.json`. Dos fases (spec §0):
 *
 *  - Fase 1 (findDeepestCandidate): qué zona queda habilitada bajo el puntero
 *    (hit-test con buffer de 6px, depthSort estable + reverse, filtrado,
 *    cascada F-9 a null).
 *  - Fase 2 (resolveWithinZone): en qué índice dentro de esa zona (punto medio
 *    con zona muerta del 5%, asimetría F-8, RTL, correcciones de índice §3.5).
 *
 * Sin sensores, sin autoscroll, sin estado entre llamadas: entrada geométrica →
 * `{slotId, index}` o `{null, null}` ("no actualizar el preview este tick").
 */

import type {
  ComponentGeom,
  DndDirection,
  DndPoint,
  DndRect,
  DragTarget,
  ResolveDragInput,
  ZoneFlow,
  ZoneGeom,
} from "./types";

/** Contracción del bounding box de cada candidato antes del hit-test (spec §0). */
export const DND_BUFFER = 6;

/** Zona muerta alrededor del punto medio: 5% de la dimensión relevante (spec §0/§3.3). */
export const DND_MIDPOINT_OFFSET = 0.05;

/** Literal del fork (`lib/root-droppable-id.ts`). */
export const ROOT_DROPPABLE_ID = "root:default-zone";

const NO_TARGET: DragTarget = { slotId: null, index: null };

/* ------------------------------------------------------------------ */
/* Geometría básica                                                     */
/* ------------------------------------------------------------------ */

function rectWidth(r: DndRect): number {
  return r.right - r.left;
}

function rectHeight(r: DndRect): number {
  return r.bottom - r.top;
}

function rectArea(r: DndRect): number {
  return Math.max(0, rectWidth(r)) * Math.max(0, rectHeight(r));
}

function pointInRect(p: DndPoint, r: DndRect): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** Hit-test contra la caja contraída BUFFER px por lado (spec §1.1 paso 5). */
function pointInContractedRect(p: DndPoint, r: DndRect): boolean {
  return (
    p.x >= r.left + DND_BUFFER &&
    p.x <= r.right - DND_BUFFER &&
    p.y >= r.top + DND_BUFFER &&
    p.y <= r.bottom - DND_BUFFER
  );
}

function overlap1D(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

function intersectionArea(a: DndRect, b: DndRect): number {
  const w = overlap1D(a.left, a.right, b.left, b.right);
  const h = overlap1D(a.top, a.bottom, b.top, b.bottom);
  return w > 0 && h > 0 ? w * h : 0;
}

/* ------------------------------------------------------------------ */
/* Aplanado del árbol de layout                                         */
/* ------------------------------------------------------------------ */

interface FlatZone {
  kind: "zone";
  node: ZoneGeom;
  /** Ids ancestros desde la raíz, EXCLUYENDO el propio nodo (spec §0 `path`). */
  path: string[];
  /** Orden DFS pre-order: aproxima el orden de pintado (mayor = más al frente). */
  order: number;
}

interface FlatComponent {
  kind: "component";
  node: ComponentGeom;
  parentZone: ZoneGeom;
  indexInZone: number;
  path: string[];
  order: number;
}

type FlatEntry = FlatZone | FlatComponent;

interface FlatLayout {
  entries: FlatEntry[];
  zonesById: Map<string, ZoneGeom>;
  componentsById: Map<string, FlatComponent>;
}

/**
 * Memo de 1 entrada por REFERENCIA del layout: durante un drag el driver pasa
 * el mismo objeto layout tick a tick, así que el aplanado se paga una vez por
 * layout, no una vez por pointermove. Un layout nuevo (otra referencia) lo
 * invalida; el WeakMap no retiene el layout anterior.
 */
const flattenMemo = new WeakMap<ZoneGeom, FlatLayout>();

function flatten(root: ZoneGeom): FlatLayout {
  const cached = flattenMemo.get(root);
  if (cached) return cached;
  const flat = flattenUncached(root);
  flattenMemo.set(root, flat);
  return flat;
}

function flattenUncached(root: ZoneGeom): FlatLayout {
  const entries: FlatEntry[] = [];
  const zonesById = new Map<string, ZoneGeom>();
  const componentsById = new Map<string, FlatComponent>();
  let order = 0;

  const walkZone = (zone: ZoneGeom, path: string[]): void => {
    entries.push({ kind: "zone", node: zone, path, order: order++ });
    zonesById.set(zone.id, zone);
    const childPath = [...path, zone.id];
    zone.items.forEach((item, indexInZone) => {
      const flat: FlatComponent = {
        kind: "component",
        node: item,
        parentZone: zone,
        indexInZone,
        path: childPath,
        order: order++,
      };
      entries.push(flat);
      componentsById.set(item.id, flat);
      const compPath = [...childPath, item.id];
      for (const z of item.zones) walkZone(z, compPath);
    });
  };

  walkZone(root, []);
  return { entries, zonesById, componentsById };
}

/* ------------------------------------------------------------------ */
/* accepts() — allow/disallow (spec §1.5)                               */
/* ------------------------------------------------------------------ */

/**
 * Fidelidad al `acceptsTarget` del fork: `disallow` y `allow` son ramas
 * if/else-if — con ambos presentes, `allow` solo rescata tipos de `disallow`
 * (filteredDisallow = disallow − allow); la allow-list pura solo actúa sola.
 */
export function zoneAccepts(zone: ZoneGeom, componentType: string | null | undefined): boolean {
  if (componentType == null) return true;
  const allow = zone.accepts;
  const disallow = zone.disallow;
  if (disallow) {
    const filteredDisallow = disallow.filter((t) => !(allow ?? []).includes(t));
    if (filteredDisallow.includes(componentType)) return false;
  } else if (allow) {
    if (!allow.includes(componentType)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Fase 1 — resolución de la zona candidata (spec §1)                   */
/* ------------------------------------------------------------------ */

/**
 * Devuelve el id de la zona habilitada, o `null` cuando NINGUNA zona queda
 * habilitada este tick (F-4: todo filtrado; F-9: chrome de contenedor con
 * zona interna activa ⇒ zoneDepthIndex vacío).
 */
function findDeepestZone(flat: FlatLayout, input: ResolveDragInput): string | null {
  const { pointer, dragging, hitOrder, pointerOverDrawer } = input;

  // §1.1 paso 2: un [data-puck-drawer] bajo el puntero restringe la lista a solo
  // ese elemento (sin atributos droppables) ⇒ candidates=[] ⇒ fallback a root.
  if (pointerOverDrawer) return ROOT_DROPPABLE_ID;

  // elementsFromPoint + buffer: candidato = su caja CONTRAÍDA contiene el punto.
  const candidates = flat.entries.filter((e) => pointInContractedRect(pointer, e.node.rect));

  // "Cero candidatos desde el inicio" reafirma la raíz (spec §1.3, distinto de F-4).
  if (candidates.length === 0) return ROOT_DROPPABLE_ID;

  // Orden de entrada = elementsFromPoint (más al frente primero). Por defecto:
  // reverse-DFS (hijos/hermanos posteriores pintan encima), con zIndex explícito
  // ganando de forma estable. `hitOrder` lo sobreescribe cuando el caso lo declara.
  const paintZ = (e: FlatEntry): number => (e.kind === "component" ? (e.node.zIndex ?? 0) : 0);
  candidates.sort((a, b) => b.order - a.order);
  candidates.sort((a, b) => paintZ(b) - paintZ(a));
  if (hitOrder) {
    const pos = new Map(hitOrder.map((id, i) => [id, i]));
    candidates.sort((a, b) => (pos.get(a.node.id) ?? Infinity) - (pos.get(b.node.id) ?? Infinity));
  }

  // depthSort (§1.2): sort ESTABLE ascendente. El reverse() posterior invierte
  // también el orden relativo de los empatados — en empate exacto de profundidad
  // gana el que elementsFromPoint listó ÚLTIMO (F-2, contraintuitivo a propósito).
  candidates.sort((a, b) => a.node.depth - b.node.depth);

  // §1.3 paso 1: remover el propio ítem arrastrado si aparece como candidato.
  const sourceId = dragging.type === "existing" ? (dragging.sourceId ?? null) : null;
  const selfIndex = sourceId === null ? -1 : candidates.findIndex((c) => c.node.id === sourceId);
  const hadSelf = selfIndex > -1;
  if (hadSelf) candidates.splice(selfIndex, 1);

  // §1.3 paso 2: filtrado preservando orden.
  const type = dragging.componentType;
  const filtered = candidates.filter((c) => {
    // Descendientes del arrastrado — SOLO si el arrastrado apareció como candidato
    // este tick (F-3: la guarda autoritativa es la de Fase 2, esta es best-effort).
    if (hadSelf && sourceId !== null && c.path.includes(sourceId)) return false;
    if (c.kind === "zone") {
      if (!zoneAccepts(c.node, type)) return false; // isDroppableTarget === false
      if (sourceId !== null && c.node.areaId === sourceId) return false; // zona del propio arrastrado
    } else if (!zoneAccepts(c.parentZone, type)) {
      return false; // inDroppableZone === false
    }
    return true;
  });

  // §1.3 pasos 3-4: reverse ⇒ mayor profundidad primero; el primero gana.
  filtered.reverse();
  const primary = filtered[0];
  if (!primary) return null; // F-4: candidatos existían pero todos filtrados.

  // §1.4 getZoneId.
  if (primary.kind === "component") {
    // containsActiveZone: ≥1 zona hija propia activa para el tipo arrastrado.
    const containsActiveZone = primary.node.zones.some((z) => zoneAccepts(z, type));
    if (containsActiveZone) return null; // F-9: chrome del contenedor ⇒ nada habilitado.
    return primary.parentZone.id; // soltar "junto a" este componente, en la zona del padre.
  }
  return primary.node.id;
}

/* ------------------------------------------------------------------ */
/* Fase 2 — índice dentro de la zona habilitada (spec §3)               */
/* ------------------------------------------------------------------ */

function zoneDragAxis(flow: ZoneFlow): "x" | "y" | "dynamic" {
  if (flow === "row") return "x";
  if (flow === "grid") return "dynamic";
  return "y";
}

/**
 * getMidpointImpact (spec §3.3). Asimetría F-8: down/left/right usan `>=`
 * (inclusivo), up usa `<` (estricto). `null` cae en la rama right (F-7).
 * El offset usa la dimensión relevante a la DIRECCIÓN (alto para up/down,
 * ancho para left/right/null).
 */
function overMidpoint(direction: DndDirection, drag: DndRect, drop: DndRect): boolean {
  const cx = (drop.left + drop.right) / 2;
  const cy = (drop.top + drop.bottom) / 2;
  if (direction === "down") return drag.bottom >= cy + DND_MIDPOINT_OFFSET * rectHeight(drop);
  if (direction === "up") return drag.top < cy - DND_MIDPOINT_OFFSET * rectHeight(drop);
  if (direction === "left") return cx - DND_MIDPOINT_OFFSET * rectWidth(drop) >= drag.left;
  return drag.right - DND_MIDPOINT_OFFSET * rectWidth(drop) >= cx; // "right" y null (F-7)
}

/**
 * Restricción del fallback (spec §3.4.3): solo se evalúa si el dragShape
 * proyecta sobre el dropShape en el eje ORTOGONAL al eje de arrastre.
 */
function orthogonalOverlap(axis: "x" | "y" | "dynamic", drag: DndRect, drop: DndRect): boolean {
  if (axis === "y") return overlap1D(drag.left, drag.right, drop.left, drop.right) > 0;
  return overlap1D(drag.top, drag.bottom, drop.top, drop.bottom) > 0;
}

/** Proxy de closestCorners: media de las distancias entre esquinas homólogas. */
function closestCornersDistance(a: DndRect, b: DndRect): number {
  const d = (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x2 - x1, y2 - y1);
  return (
    (d(a.left, a.top, b.left, b.top) +
      d(a.right, a.top, b.right, b.top) +
      d(a.left, a.bottom, b.left, b.bottom) +
      d(a.right, a.bottom, b.right, b.bottom)) /
    4
  );
}

/** Prioridades de colisión (spec §3.4): Highest > High > Low > Lowest. */
const PRIORITY = { highest: 4, high: 3, low: 2, lowest: 1 } as const;

interface Collision {
  item: ComponentGeom;
  indexInZone: number;
  priority: number;
  value: number;
}

function firstSegment(id: string): string {
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(0, i);
}

function resolveWithinZone(zone: ZoneGeom, input: ResolveDragInput, flat: FlatLayout): DragTarget {
  const { pointer, dragging } = input;
  const sourceId = dragging.type === "existing" ? (dragging.sourceId ?? null) : null;

  // Zona vacía (spec §8.1): el contenedor mismo es el droppable, detector
  // pointerIntersection (punto-en-rect simple, sin buffer), índice siempre 0.
  if (zone.items.length === 0) {
    return pointInRect(pointer, zone.rect) ? { slotId: zone.id, index: 0 } : NO_TARGET;
  }

  const axis = zoneDragAxis(zone.direction);
  const fallbackEnabled = dragging.fallbackEnabled !== false;

  // Un detector por ítem; gana la mayor (prioridad, valor); empate exacto de
  // valor ⇒ el primero en orden de registro (= orden del array de la zona).
  let winner: Collision | null = null;
  zone.items.forEach((item, indexInZone) => {
    let collision: { priority: number; value: number } | null = null;
    if (sourceId !== null && item.id === sourceId) {
      // §3.4.1 "origen pegajoso": el droppable del propio origen SOLO se evalúa
      // con directionalCollision (distancia decreciente hacia su centro). Si el
      // driver provee `originApproaching` (trackeo real de distancia), manda;
      // si no (undefined), proxy puro sin historial de movimiento: el puntero
      // está dentro del propio rect. Divergencia documentada en dnd-spec.md.
      const approaching = dragging.originApproaching;
      if (approaching !== undefined ? approaching : pointInRect(pointer, item.rect)) {
        collision = { priority: PRIORITY.highest, value: 0 };
      }
    } else {
      const inter = intersectionArea(dragging.rect, item.rect);
      if (inter > 0 && overMidpoint(dragging.direction, dragging.rect, item.rect)) {
        // §3.4.2 High: intersección real + punto medio; valor = intersectionRatio.
        collision = { priority: PRIORITY.high, value: inter / rectArea(item.rect) };
      } else if (fallbackEnabled && orthogonalOverlap(axis, dragging.rect, item.rect)) {
        // §3.4.3 Low/Lowest: proximidad, solo con solape en el eje ortogonal.
        collision = {
          priority: inter > 0 ? PRIORITY.low : PRIORITY.lowest,
          value: -closestCornersDistance(dragging.rect, item.rect),
        };
      }
    }
    if (
      collision &&
      (!winner ||
        collision.priority > winner.priority ||
        (collision.priority === winner.priority && collision.value > winner.value))
    ) {
      winner = { item, indexInZone, ...collision };
    }
  });

  if (!winner) return NO_TARGET;
  const target: Collision = winner;

  // Guardas de §3.5 (la defensa AUTORITATIVA contra self/descendiente, cf. F-3):
  // comparación por primer segmento del id, y path del target contra el origen.
  if (sourceId !== null) {
    const srcSeg = firstSegment(sourceId);
    if (firstSegment(target.item.id) === srcSeg) return NO_TARGET;
    const targetFlat = flat.componentsById.get(target.item.id);
    if (targetFlat && targetFlat.path.some((p) => firstSegment(p) === srcSeg)) return NO_TARGET;
  }

  // §3.5: before/after según direction y el dir RTL-aware del target.
  const d = dragging.direction;
  const before =
    d === "up" || (zone.dir === "ltr" && d === "left") || (zone.dir === "rtl" && d === "right");

  // Orden de correcciones (§3.5): primero el shift de misma-zona, DESPUÉS el +1.
  let index = target.indexInZone;
  if (sourceId !== null) {
    const src = flat.componentsById.get(sourceId);
    if (src && src.parentZone.id === zone.id && index >= src.indexInZone) index -= 1;
  }
  if (!before) index += 1;

  return { slotId: zone.id, index };
}

/* ------------------------------------------------------------------ */
/* API pública                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resuelve el destino del drag para un tick: `{slotId, index}` o `{null, null}`
 * cuando el motor NO debe actualizar el preview (F-4, F-9, guardas §3.5, o
 * ningún detector produjo colisión).
 */
export function resolveDragTarget(input: ResolveDragInput): DragTarget {
  const flat = flatten(input.layout);
  const zoneId = findDeepestZone(flat, input);
  if (zoneId === null) return NO_TARGET;
  const zone = flat.zonesById.get(zoneId);
  if (!zone) return NO_TARGET; // habilitación sin geometría conocida: sin target.
  return resolveWithinZone(zone, input, flat);
}
