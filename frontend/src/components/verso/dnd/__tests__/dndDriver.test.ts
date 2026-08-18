/**
 * Verso DnD — tests del driver de sensores (F2).
 *
 * ENTORNO: node (el proyecto no tiene jsdom/happy-dom y las dependencias nuevas
 * están vetadas — mismo patrón que geometryStore.test.ts): la sesión y el
 * núcleo del driver son puros/inyectables por diseño, así que se testean con
 * layouts geométricos sintéticos y el EditorHandle REAL. La geometría con
 * layout de navegador (drag visual, escala del device-preview, autoscroll
 * real) queda para la verificación en navegador del orquestador.
 *
 * Cubre:
 *  1. INVARIANTE solo-comandos: una sesión completa de moves jamás llama
 *     transact ni cambia la referencia del doc; el drop llama transact UNA vez
 *     con el comando exacto esperado; Escape/cancel solo limpia el preview.
 *  2. Tracker de originApproaching (histéresis de 10px, spec §3.4.1).
 *  3. Traducción de coordenadas padre→iframe con escala 0.5/0.75 y offset
 *     (toFramePoint: la fórmula rect.width/clientWidth bajo transform: scale()).
 *  4. Modo teclado: moveNode correcto en las 4 direcciones + anuncio aria-live.
 *  5. buildDragLayout: profundidades, accepts del registry, fail-soft sin rect.
 */
import { describe, expect, it } from "vitest";
import { createEditor, type EditorHandle, type VersoTransactionApi } from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockRegistry } from "@/lib/verso/registry";
import { ROOT_ID, ROOT_SLOT, type VersoData, type VersoItem } from "@/lib/verso/types";
import type { DndRect, ZoneGeom } from "@/lib/verso/dnd/types";
import { ROOT_DROPPABLE_ID } from "@/lib/verso/dnd/resolve";
import {
  autoscrollVelocity,
  buildDragLayout,
  createDirectionTracker,
  createPointerGesture,
  createKeyboardMover,
  createOriginTracker,
  frameScaleOf,
  keyboardMoveTarget,
  parseZoneId,
  toFramePoint,
  translateParentPoint,
  zoneIdFor,
} from "../driverCore";
import { createDragSession } from "../session";

/* ------------------------------------------------------------------ */
/* Utilería                                                             */
/* ------------------------------------------------------------------ */

const R = (left: number, top: number, right: number, bottom: number): DndRect => ({
  left,
  top,
  right,
  bottom,
});

function makeRegistry(): BlockRegistry {
  const registry = createBlockRegistry();
  const render = () => null;
  registry.register([
    { type: "Heading", label: "Encabezado", fields: { title: { type: "text" } }, defaultProps: { title: "H" }, render },
    { type: "Card", label: "Tarjeta", fields: { title: { type: "text" } }, defaultProps: { title: "Tarjeta" }, render },
    {
      type: "Section",
      label: "Sección",
      fields: { children: { type: "slot" } },
      defaultProps: { children: [] },
      render,
    },
  ]);
  return registry;
}

/** Doc: raíz [h1(Heading), sec(Section > [a(Card), b(Card)]), h2(Heading)]. */
function makeData(): VersoData {
  return {
    content: [
      { type: "Heading", props: { id: "h1", title: "Uno" } },
      {
        type: "Section",
        props: {
          id: "sec",
          children: [
            { type: "Card", props: { id: "a", title: "A" } },
            { type: "Card", props: { id: "b", title: "B" } },
          ],
        },
      },
      { type: "Heading", props: { id: "h2", title: "Dos" } },
    ],
    root: { props: {} },
  };
}

/**
 * Layout geométrico del doc anterior (coordenadas del iframe):
 * columna raíz 800×600 con h1 arriba, sec en medio (con su zona interna y
 * a/b apilados) y h2 abajo.
 */
function makeLayout(): ZoneGeom {
  return {
    id: ROOT_DROPPABLE_ID,
    kind: "zone",
    areaId: "root",
    depth: 0,
    direction: "column",
    dir: "ltr",
    accepts: null,
    rect: R(0, 0, 800, 600),
    items: [
      { id: "h1", kind: "component", componentType: "Heading", depth: 1, rect: R(0, 0, 800, 100), zones: [] },
      {
        id: "sec",
        kind: "component",
        componentType: "Section",
        depth: 1,
        rect: R(0, 100, 800, 400),
        zones: [
          {
            id: "sec:children",
            kind: "zone",
            areaId: "sec",
            depth: 2,
            direction: "column",
            dir: "ltr",
            accepts: null,
            rect: R(10, 110, 790, 390),
            items: [
              { id: "a", kind: "component", componentType: "Card", depth: 3, rect: R(10, 110, 790, 240), zones: [] },
              { id: "b", kind: "component", componentType: "Card", depth: 3, rect: R(10, 250, 790, 390), zones: [] },
            ],
          },
        ],
      },
      { id: "h2", kind: "component", componentType: "Heading", depth: 1, rect: R(0, 400, 800, 500), zones: [] },
    ],
  };
}

interface RecordedCommand {
  kind: string;
  [k: string]: unknown;
}

/**
 * Envuelve el EditorHandle real espiando transact Y los comandos emitidos por
 * la transacción (el mock exigido por el invariante solo-comandos).
 */
function spyHandle(handle: EditorHandle): {
  wrapped: EditorHandle;
  transactCalls: number[];
  commands: RecordedCommand[];
} {
  const transactCalls: number[] = [];
  const commands: RecordedCommand[] = [];
  const wrapped: EditorHandle = {
    ...handle,
    transact: (fn, opts) => {
      transactCalls.push(1);
      return handle.transact((tx) => {
        const recording: VersoTransactionApi = {
          insertNode: (item, parentId, slotKey, index) => {
            commands.push({ kind: "insertNode", item, parentId, slotKey, index });
            tx.insertNode(item, parentId, slotKey, index);
          },
          moveNode: (nodeId, toParentId, toSlotKey, toIndex) => {
            commands.push({ kind: "moveNode", nodeId, toParentId, toSlotKey, toIndex });
            tx.moveNode(nodeId, toParentId, toSlotKey, toIndex);
          },
          removeNode: (nodeId) => {
            commands.push({ kind: "removeNode", nodeId });
            tx.removeNode(nodeId);
          },
          setProps: (nodeId, patch) => {
            commands.push({ kind: "setProps", nodeId, patch });
            tx.setProps(nodeId, patch);
          },
          setRootProps: (patch) => {
            commands.push({ kind: "setRootProps", patch });
            tx.setRootProps(patch);
          },
          duplicateSubtree: (nodeId, idMap) => {
            commands.push({ kind: "duplicateSubtree", nodeId, idMap });
            tx.duplicateSubtree(nodeId, idMap);
          },
          replaceData: (data) => {
            commands.push({ kind: "replaceData", data });
            tx.replaceData(data);
          },
        };
        fn(recording);
      }, opts);
    },
  };
  return { wrapped, transactCalls, commands };
}

function makeBench() {
  const registry = makeRegistry();
  const handle = createEditor({ initialData: makeData(), isSlot: makeSlotResolver(registry) });
  const spy = spyHandle(handle);
  const layout = makeLayout();
  return { registry, handle, spy, layout };
}

/* ------------------------------------------------------------------ */
/* 1. Invariante solo-comandos                                          */
/* ------------------------------------------------------------------ */

describe("DragSession — invariante solo-comandos", () => {
  it("una sesión completa de moves sin drop: CERO transact y el doc conserva su referencia", () => {
    const { registry, handle, spy, layout } = makeBench();
    const docBefore = handle.getDoc();
    const session = createDragSession(
      { handle: spy.wrapped, registry, getLayout: () => layout },
      { kind: "existing", nodeId: "h1", originRect: R(0, 0, 800, 100) },
      { x: 400, y: 50 },
    );

    // Tick 1: sobre sí mismo — guarda §3.5 ⇒ preview sigue null.
    session.move({ x: 400, y: 55 });
    expect(spy.wrapped.getState().dragPreview).toBeNull();

    // Tick 2: dentro de la zona del Section — preview en sec:children índice 1.
    session.move({ x: 400, y: 200 });
    expect(spy.wrapped.getState().dragPreview).toEqual({
      source: { kind: "existing", nodeId: "h1" },
      targetParentId: "sec",
      targetSlotKey: "children",
      targetIndex: 1,
    });

    // Tick 3: bajo h2 en la raíz — preview raíz índice 2 (shift de misma zona + after).
    session.move({ x: 400, y: 470 });
    expect(spy.wrapped.getState().dragPreview).toEqual({
      source: { kind: "existing", nodeId: "h1" },
      targetParentId: ROOT_ID,
      targetSlotKey: ROOT_SLOT,
      targetIndex: 2,
    });

    // EL INVARIANTE: nada de transact, el doc es LA MISMA referencia.
    expect(spy.transactCalls).toHaveLength(0);
    expect(spy.commands).toHaveLength(0);
    expect(handle.getDoc()).toBe(docBefore);
  });

  it("el drop llama transact UNA vez con el moveNode exacto del preview vigente", () => {
    const { registry, handle, spy, layout } = makeBench();
    const session = createDragSession(
      { handle: spy.wrapped, registry, getLayout: () => layout },
      { kind: "existing", nodeId: "h1", originRect: R(0, 0, 800, 100) },
      { x: 400, y: 50 },
    );
    session.move({ x: 400, y: 55 });
    session.move({ x: 400, y: 470 });
    expect(session.drop()).toBe(true);

    expect(spy.transactCalls).toHaveLength(1);
    expect(spy.commands).toEqual([
      { kind: "moveNode", nodeId: "h1", toParentId: ROOT_ID, toSlotKey: ROOT_SLOT, toIndex: 2 },
    ]);
    expect(handle.getDoc().rootChildren).toEqual(["sec", "h2", "h1"]);
    expect(handle.getState().dragPreview).toBeNull();
    // Post-drop, la sesión está sellada: ni moves ni drops adicionales mutan nada.
    session.move({ x: 400, y: 200 });
    expect(session.drop()).toBe(false);
    expect(spy.transactCalls).toHaveLength(1);
  });

  it("drop desde la paleta: UNA transact con insertNode (id generado + defaultProps del registry)", () => {
    const { registry, handle, spy, layout } = makeBench();
    const session = createDragSession(
      { handle: spy.wrapped, registry, getLayout: () => layout, generateId: () => "nuevo-1" },
      { kind: "new", type: "Card" },
      { x: 0, y: 0 },
    );
    session.move({ x: 400, y: 470 });
    expect(spy.wrapped.getState().dragPreview).toEqual({
      source: { kind: "new", type: "Card" },
      targetParentId: ROOT_ID,
      targetSlotKey: ROOT_SLOT,
      targetIndex: 3,
    });
    expect(session.drop()).toBe(true);
    expect(spy.transactCalls).toHaveLength(1);
    const cmd = spy.commands[0];
    expect(cmd.kind).toBe("insertNode");
    expect(cmd.parentId).toBe(ROOT_ID);
    expect(cmd.slotKey).toBe(ROOT_SLOT);
    expect(cmd.index).toBe(3);
    expect(cmd.item as VersoItem).toEqual({ type: "Card", props: { title: "Tarjeta", id: "nuevo-1" } });
    expect(handle.getDoc().rootChildren).toEqual(["h1", "sec", "h2", "nuevo-1"]);
  });

  it("Escape/cancel: solo limpia el preview — ni transact ni cambio de referencia del doc", () => {
    const { registry, handle, spy, layout } = makeBench();
    const docBefore = handle.getDoc();
    const session = createDragSession(
      { handle: spy.wrapped, registry, getLayout: () => layout },
      { kind: "existing", nodeId: "h1", originRect: R(0, 0, 800, 100) },
      { x: 400, y: 50 },
    );
    session.move({ x: 400, y: 470 });
    expect(spy.wrapped.getState().dragPreview).not.toBeNull();
    session.cancel();
    expect(spy.wrapped.getState().dragPreview).toBeNull();
    expect(spy.transactCalls).toHaveLength(0);
    expect(handle.getDoc()).toBe(docBefore);
    // Tras cancel la sesión está sellada: un drop tardío no transacciona.
    expect(session.drop()).toBe(false);
    expect(spy.transactCalls).toHaveLength(0);
  });

  it("{null,null} del resolutor (ej. drawer bajo el puntero sin zona real) no borra el preview vigente", () => {
    const { registry, spy, layout } = makeBench();
    const session = createDragSession(
      { handle: spy.wrapped, registry, getLayout: () => layout },
      { kind: "existing", nodeId: "h1", originRect: R(0, 0, 800, 100) },
      { x: 400, y: 50 },
    );
    session.move({ x: 400, y: 470 });
    const preview = spy.wrapped.getState().dragPreview;
    expect(preview).not.toBeNull();
    // Sobre el propio origen (guarda §3.5 ⇒ {null,null}): el preview NO cambia.
    session.move({ x: 400, y: 50 });
    expect(spy.wrapped.getState().dragPreview).toBe(preview);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Tracker de originApproaching                                      */
/* ------------------------------------------------------------------ */

describe("createOriginTracker — histéresis de 10px (spec §3.4.1)", () => {
  it("undefined antes de moverse; acercándose=true; alejándose=false; jitter <10px no mueve la referencia", () => {
    // Origen centrado en (100,100).
    const tracker = createOriginTracker(R(50, 50, 150, 150));
    // Primer punto: solo fija la referencia — sin señal todavía.
    expect(tracker.update({ x: 200, y: 100 })).toBeUndefined();
    // Se acerca (dist 100 → 50): true. Referencia avanza (delta 50 > 10).
    expect(tracker.update({ x: 150, y: 100 })).toBe(true);
    // Se aleja 5px (dist 50 → 55): false… y la referencia NO avanza (5 < 10).
    expect(tracker.update({ x: 155, y: 100 })).toBe(false);
    // Vuelve a 152: dist 52 sigue > 50 (la referencia quedó en 150) ⇒ sigue false.
    expect(tracker.update({ x: 152, y: 100 })).toBe(false);
    // Se acerca de verdad (dist 20 < 50): true; referencia avanza (delta 30).
    expect(tracker.update({ x: 120, y: 100 })).toBe(true);
    // Distancia EXACTAMENTE igual conserva el estado previo.
    expect(tracker.update({ x: 120, y: 100 })).toBe(true);
  });
});

describe("createDirectionTracker — dirección con histéresis (spec §3.2)", () => {
  it("null en el primer tick; deriva por eje dominante; empate exacto cae en X (F-6); delta 0 conserva", () => {
    const t = createDirectionTracker();
    expect(t.update({ x: 0, y: 0 })).toBeNull();
    expect(t.update({ x: 0, y: 40 })).toBe("down");
    // Empate |dx|===|dy| respecto a la referencia: rama X.
    expect(t.update({ x: 30, y: 70 })).toBe("right");
    // Sin movimiento: conserva la última dirección.
    expect(t.update({ x: 30, y: 70 })).toBe("right");
  });
});

/* ------------------------------------------------------------------ */
/* 3. Traducción de coordenadas                                         */
/* ------------------------------------------------------------------ */

describe("translateParentPoint — offset del iframe + escala del device-preview", () => {
  it("con escala 0.5 y offset (100,200): un punto del padre se traduce al sistema del iframe", () => {
    expect(translateParentPoint(110, 220, { left: 100, top: 200 }, 0.5)).toEqual({ x: 20, y: 40 });
    expect(translateParentPoint(500, 500, { left: 100, top: 200 }, 0.5)).toEqual({ x: 800, y: 600 });
  });
  it("escala 1 = solo offset; escala inválida (0/NaN) cae a 1 sin dividir por cero", () => {
    expect(translateParentPoint(150, 260, { left: 100, top: 200 }, 1)).toEqual({ x: 50, y: 60 });
    expect(translateParentPoint(150, 260, { left: 100, top: 200 }, 0)).toEqual({ x: 50, y: 60 });
    expect(translateParentPoint(150, 260, { left: 100, top: 200 }, Number.NaN)).toEqual({ x: 50, y: 60 });
  });
});

describe("toFramePoint — la fórmula rect.width/clientWidth bajo transform: scale()", () => {
  it("frameScaleOf: transform no altera clientWidth y rect.width = clientWidth·s ⇒ el cociente ES s", () => {
    // Device-preview escritorio 1280 escalado 0.75: rect visual 960.
    expect(frameScaleOf(960, 1280)).toBe(0.75);
    // Sin transform: identidad. clientWidth 0: fail-soft a 1.
    expect(frameScaleOf(1280, 1280)).toBe(1);
    expect(frameScaleOf(400, 0)).toBe(1);
  });

  it("escala 0.75: ida y vuelta padre↔iframe exacta (el caso del encargo)", () => {
    const box = { left: 52, top: 96, width: 960, clientWidth: 1280 };
    // Punto interno (400, 240) pintado en el padre en (52+300, 96+180).
    expect(toFramePoint(352, 276, box)).toEqual({ x: 400, y: 240 });
    // La esquina del iframe es el origen del sistema interno.
    expect(toFramePoint(52, 96, box)).toEqual({ x: 0, y: 0 });
    // Compuesta con la proyección directa: identidad para cualquier punto.
    const s = 0.75;
    const inner = { x: 123.5, y: 77.25 };
    const projected = { x: box.left + inner.x * s, y: box.top + inner.y * s };
    const back = toFramePoint(projected.x, projected.y, box);
    expect(back.x).toBeCloseTo(inner.x, 10);
    expect(back.y).toBeCloseTo(inner.y, 10);
  });

  it("iframe sin layout (clientWidth 0): cae a escala 1 — solo offset", () => {
    expect(toFramePoint(150, 260, { left: 100, top: 200, width: 0, clientWidth: 0 })).toEqual({
      x: 50,
      y: 60,
    });
  });
});

describe("zoneIdFor/parseZoneId — ida y vuelta incluida la raíz", () => {
  it("la raíz usa el literal del fork y cualquier otro slot es parentId:slotKey", () => {
    expect(zoneIdFor(ROOT_ID, ROOT_SLOT)).toBe(ROOT_DROPPABLE_ID);
    expect(parseZoneId(ROOT_DROPPABLE_ID)).toEqual({ parentId: ROOT_ID, slotKey: ROOT_SLOT });
    expect(zoneIdFor("sec", "children")).toBe("sec:children");
    expect(parseZoneId("sec:children")).toEqual({ parentId: "sec", slotKey: "children" });
  });
});

describe("autoscrollVelocity — proporcional a la proximidad al borde", () => {
  it("cero en el centro; negativa cerca del borde superior/izquierdo; positiva cerca del inferior/derecho", () => {
    const viewport = { width: 800, height: 600 };
    expect(autoscrollVelocity({ x: 400, y: 300 }, viewport)).toEqual({ x: 0, y: 0 });
    const nearTop = autoscrollVelocity({ x: 400, y: 10 }, viewport);
    expect(nearTop.x).toBe(0);
    expect(nearTop.y).toBeLessThan(0);
    const nearRight = autoscrollVelocity({ x: 795, y: 300 }, viewport);
    expect(nearRight.x).toBeGreaterThan(0);
    // Más cerca del borde = más rápido.
    const far = autoscrollVelocity({ x: 400, y: 140 }, viewport);
    expect(Math.abs(nearTop.y)).toBeGreaterThan(Math.abs(far.y));
  });
});

/* ------------------------------------------------------------------ */
/* 4. Modo teclado                                                      */
/* ------------------------------------------------------------------ */

describe("createKeyboardMover — moveNode en las 4 direcciones + anuncio aria-live", () => {
  function makeKeyboardBench() {
    const { registry, handle, spy } = makeBench();
    const announcements: string[] = [];
    const mover = createKeyboardMover({
      handle: spy.wrapped,
      registry,
      announce: (m) => announcements.push(m),
    });
    return { registry, handle, spy, mover, announcements };
  }

  it("Ctrl+Shift+ArrowDown/Up: hermano siguiente/anterior en el mismo slot, con anuncio", () => {
    const { handle, spy, mover, announcements } = makeKeyboardBench();
    handle.select("a");
    expect(mover.handleKey({ key: "ArrowDown", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(spy.commands.at(-1)).toEqual({
      kind: "moveNode",
      nodeId: "a",
      toParentId: "sec",
      toSlotKey: "children",
      toIndex: 1,
    });
    expect(handle.getDoc().nodes.sec.slots.children).toEqual(["b", "a"]);
    expect(announcements.at(-1)).toBe("Tarjeta movido a Sección › children posición 2");

    expect(mover.handleKey({ key: "ArrowUp", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(spy.commands.at(-1)).toEqual({
      kind: "moveNode",
      nodeId: "a",
      toParentId: "sec",
      toSlotKey: "children",
      toIndex: 0,
    });
    expect(handle.getDoc().nodes.sec.slots.children).toEqual(["a", "b"]);
    expect(announcements.at(-1)).toBe("Tarjeta movido a Sección › children posición 1");
  });

  it("Ctrl+Shift+ArrowLeft: sale al slot del padre justo después del contenedor", () => {
    const { handle, spy, mover, announcements } = makeKeyboardBench();
    handle.select("a");
    expect(mover.handleKey({ key: "ArrowLeft", metaKey: true, shiftKey: true })).toBe(true);
    expect(spy.commands.at(-1)).toEqual({
      kind: "moveNode",
      nodeId: "a",
      toParentId: ROOT_ID,
      toSlotKey: ROOT_SLOT,
      toIndex: 2,
    });
    expect(handle.getDoc().rootChildren).toEqual(["h1", "sec", "a", "h2"]);
    expect(announcements.at(-1)).toBe("Tarjeta movido a raíz posición 3");
  });

  it("Ctrl+Shift+ArrowRight: entra al slot del hermano adyacente (el anterior, al final)", () => {
    const { handle, spy, mover, announcements } = makeKeyboardBench();
    // Coloca a en la raíz, después de sec.
    handle.transact((tx) => tx.moveNode("a", ROOT_ID, ROOT_SLOT, 2));
    handle.select("a");
    expect(mover.handleKey({ key: "ArrowRight", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(spy.commands.at(-1)).toEqual({
      kind: "moveNode",
      nodeId: "a",
      toParentId: "sec",
      toSlotKey: "children",
      toIndex: 1,
    });
    expect(handle.getDoc().nodes.sec.slots.children).toEqual(["b", "a"]);
    expect(announcements.at(-1)).toBe("Tarjeta movido a Sección › children posición 2");
  });

  it("M entra en modo mover (flechas sueltas mueven) y Escape sale con anuncio", () => {
    const { handle, spy, mover, announcements } = makeKeyboardBench();
    handle.select("a");
    // Flecha suelta SIN modo: no consumida, nada se mueve.
    expect(mover.handleKey({ key: "ArrowDown" })).toBe(false);
    expect(spy.transactCalls).toHaveLength(0);

    expect(mover.handleKey({ key: "m" })).toBe(true);
    expect(mover.isMoveMode()).toBe(true);
    expect(announcements.at(-1)).toContain("Modo mover");

    expect(mover.handleKey({ key: "ArrowDown" })).toBe(true);
    expect(handle.getDoc().nodes.sec.slots.children).toEqual(["b", "a"]);

    expect(mover.handleKey({ key: "Escape" })).toBe(true);
    expect(mover.isMoveMode()).toBe(false);
    expect(announcements.at(-1)).toBe("Modo mover desactivado");
    // Fuera del modo, la flecha suelta vuelve a no consumirse.
    expect(mover.handleKey({ key: "ArrowDown" })).toBe(false);
  });

  it("sin selección no consume nada; en los bordes (sin destino) no abre transacción", () => {
    const { handle, spy, mover } = makeKeyboardBench();
    expect(mover.handleKey({ key: "m" })).toBe(false);
    expect(mover.handleKey({ key: "ArrowDown", ctrlKey: true, shiftKey: true })).toBe(false);
    handle.select("h1");
    // h1 es el primero de la raíz: subir no tiene destino → consumido pero sin transact.
    expect(mover.handleKey({ key: "ArrowUp", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(spy.transactCalls).toHaveLength(0);
  });

  it("keyboardMoveTarget respeta el allow del slot al entrar por la derecha", () => {
    const registry = createBlockRegistry();
    const render = () => null;
    registry.register([
      { type: "Heading", fields: {}, defaultProps: {}, render },
      {
        type: "Section",
        fields: { children: { type: "slot", allow: ["Card"] } },
        defaultProps: {},
        render,
      },
      { type: "Card", fields: {}, defaultProps: {}, render },
    ]);
    const handle = createEditor({ initialData: makeData(), isSlot: makeSlotResolver(registry) });
    // h2 (Heading) está justo después de sec, cuyo slot solo acepta Card → sin destino.
    expect(keyboardMoveTarget(handle.getDoc(), registry, "h2", "right")).toBeNull();
    // a (Card) movido a la raíz sí puede volver a entrar.
    handle.transact((tx) => tx.moveNode("a", ROOT_ID, ROOT_SLOT, 2));
    expect(keyboardMoveTarget(handle.getDoc(), registry, "a", "right")).toEqual({
      toParentId: "sec",
      toSlotKey: "children",
      toIndex: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/* 5. buildDragLayout                                                   */
/* ------------------------------------------------------------------ */

describe("buildDragLayout — doc + geometría medida → árbol de zonas del resolutor", () => {
  const blockRects: Record<string, DndRect> = {
    h1: R(0, 0, 800, 100),
    sec: R(0, 100, 800, 400),
    a: R(10, 110, 790, 240),
    b: R(10, 250, 790, 390),
    h2: R(0, 400, 800, 500),
  };
  const slotInfos: Record<string, { rect: DndRect; flow: "column" | "row" | "grid"; dir: "ltr" | "rtl" }> = {
    [`${ROOT_ID}:${ROOT_SLOT}`]: { rect: R(0, 0, 800, 600), flow: "column", dir: "ltr" },
    "sec:children": { rect: R(10, 110, 790, 390), flow: "grid", dir: "rtl" },
  };

  function build(registry: BlockRegistry, overrides?: { skipRectOf?: string }) {
    const handle = createEditor({ initialData: makeData(), isSlot: makeSlotResolver(registry) });
    return buildDragLayout({
      doc: handle.getDoc(),
      registry,
      getBlockRect: (id) => (id === overrides?.skipRectOf ? null : (blockRects[id] ?? null)),
      getSlotInfo: (parentId, slotKey) => slotInfos[`${parentId}:${slotKey}`] ?? null,
    });
  }

  it("produce zona raíz depth 0, componentes +1 y zonas anidadas +2, con flow/dir del slot", () => {
    const layout = build(makeRegistry());
    expect(layout).not.toBeNull();
    expect(layout!.id).toBe(ROOT_DROPPABLE_ID);
    expect(layout!.depth).toBe(0);
    expect(layout!.items.map((i) => [i.id, i.depth])).toEqual([
      ["h1", 1],
      ["sec", 1],
      ["h2", 1],
    ]);
    const secZone = layout!.items[1].zones[0];
    expect(secZone.id).toBe("sec:children");
    expect(secZone.areaId).toBe("sec");
    expect(secZone.depth).toBe(2);
    expect(secZone.direction).toBe("grid");
    expect(secZone.dir).toBe("rtl");
    expect(secZone.items.map((i) => [i.id, i.depth])).toEqual([
      ["a", 3],
      ["b", 3],
    ]);
  });

  it("propaga allow/disallow del SlotVersoField del registry a la zona", () => {
    const registry = createBlockRegistry();
    const render = () => null;
    registry.register([
      { type: "Heading", fields: {}, defaultProps: {}, render },
      { type: "Card", fields: {}, defaultProps: {}, render },
      {
        type: "Section",
        fields: { children: { type: "slot", allow: ["Card"], disallow: ["Heading"] } },
        defaultProps: {},
        render,
      },
    ]);
    const layout = build(registry);
    const secZone = layout!.items[1].zones[0];
    expect(secZone.accepts).toEqual(["Card"]);
    expect(secZone.disallow).toEqual(["Heading"]);
    expect(layout!.accepts).toBeNull(); // la raíz acepta todo
  });

  it("fail-soft: un bloque sin rect medido se omite del layout sin romper el resto", () => {
    const layout = build(makeRegistry(), { skipRectOf: "b" });
    const secZone = layout!.items[1].zones[0];
    expect(secZone.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("sin la zona raíz medida el layout es null (la sesión no actualiza el preview)", () => {
    const registry = makeRegistry();
    const handle = createEditor({ initialData: makeData(), isSlot: makeSlotResolver(registry) });
    const layout = buildDragLayout({
      doc: handle.getDoc(),
      registry,
      getBlockRect: () => null,
      getSlotInfo: () => null,
    });
    expect(layout).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. El GESTO: pulsar, mover, soltar                                  */
/* ------------------------------------------------------------------ */

describe("gesto de puntero: lo decide la distancia, nunca el azar de los fotogramas", () => {
  /** Sesión de mentira que anota lo que le hacen, y un planificador de fotogramas MANUAL. */
  const harness = () => {
    const log: string[] = [];
    const frames: Array<() => void> = [];
    let nextId = 1;
    const gesture = createPointerGesture<{ id: number }>({
      createSession: (source, start) => {
        log.push(`crear:${source.kind === "new" ? source.type : source.nodeId}@${start.x},${start.y}`);
        return { id: nextId++ };
      },
      moveSession: (_s, p, over) => log.push(`mover:${p.x},${p.y}${over ? ":paleta" : ""}`),
      dropSession: () => log.push("soltar"),
      cancelSession: () => log.push("cancelar"),
      scheduleFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: (id) => {
        frames[id - 1] = () => {};
      },
    });
    /** Corre los fotogramas pendientes, como haría el navegador. */
    const tick = () => {
      const pending = frames.splice(0).filter(Boolean);
      for (const cb of pending) cb();
    };
    return { gesture, log, tick, frames };
  };

  const nuevo = { kind: "new" as const, type: "Section" };

  it("un gesto RÁPIDO (soltar antes de que pase un fotograma) suelta igual", () => {
    // Este es el defecto medido en el navegador: `pointerdown` → `pointermove` → `pointerup`
    // dentro del mismo fotograma. La sesión se creaba en el rAF, así que al soltar todavía no
    // existía y el arrastre se descartaba EN SILENCIO — el bloque no se insertaba y no había error.
    const h = harness();
    h.gesture.down(nuevo, { x: 100, y: 100 });
    h.gesture.move({ x: 400, y: 300 });
    h.gesture.up(); // ← sin un solo `tick()`
    expect(h.log).toEqual(["crear:Section@100,100", "mover:400,300", "soltar"]);
  });

  it("y suelta en el ÚLTIMO punto, no donde estaba el puntero un fotograma antes", () => {
    // El drop lee el preview que solo escribe un `move` ya aplicado: sin vaciar la cola al soltar,
    // el bloque caía en la posición del fotograma anterior. Un error de unos pocos píxeles casi
    // siempre… y de un hueco entero justo cuando el puntero acaba de cruzar a otra zona.
    const h = harness();
    h.gesture.down(nuevo, { x: 0, y: 0 });
    h.gesture.move({ x: 50, y: 50 });
    h.tick();
    h.gesture.move({ x: 900, y: 700 }); // el ajuste final, aún sin fotograma
    h.gesture.up();
    expect(h.log[h.log.length - 2]).toBe("mover:900,700");
    expect(h.log[h.log.length - 1]).toBe("soltar");
  });

  it("un TAP no arrastra: por debajo del umbral no se crea sesión ni se suelta nada", () => {
    // Es lo que protege el tap-para-insertar de la paleta: si esto se rompe, cada clic en una
    // tarjeta se convertiría en un arrastre a ninguna parte.
    const h = harness();
    h.gesture.down(nuevo, { x: 10, y: 10 });
    h.gesture.move({ x: 13, y: 12 }); // 3,6 px < 5
    h.gesture.up();
    expect(h.log).toEqual([]);
  });

  it("los movimientos se AGRUPAN por fotograma: cien ticks, una sola resolución", () => {
    // El agrupado es la razón de ser del rAF y no se pierde con el arreglo.
    const h = harness();
    h.gesture.down(nuevo, { x: 0, y: 0 });
    for (let i = 1; i <= 100; i++) h.gesture.move({ x: i * 10, y: i });
    expect(h.log).toEqual([]); // aún nada: todo está en la cola del fotograma
    h.tick();
    expect(h.log).toEqual(["crear:Section@0,0", "mover:1000,100"]);
  });

  it("Escape cancela y deja el gesto muerto: soltar después no suelta nada", () => {
    const h = harness();
    h.gesture.down(nuevo, { x: 0, y: 0 });
    h.gesture.move({ x: 200, y: 200 });
    h.tick();
    h.gesture.cancel();
    h.gesture.up();
    expect(h.log).toEqual(["crear:Section@0,0", "mover:200,200", "cancelar"]);
  });

  it("un `down` nuevo descarta el gesto anterior (no se acumulan sesiones)", () => {
    const h = harness();
    h.gesture.down(nuevo, { x: 0, y: 0 });
    h.gesture.move({ x: 300, y: 0 });
    h.tick();
    h.gesture.down({ kind: "existing", nodeId: "b1", originRect: null }, { x: 500, y: 500 });
    h.gesture.move({ x: 800, y: 500 });
    h.gesture.up();
    expect(h.log).toEqual([
      "crear:Section@0,0",
      "mover:300,0",
      "crear:b1@500,500",
      "mover:800,500",
      "soltar",
    ]);
  });

  it("el puntero sobre la paleta viaja hasta la sesión (es lo que suprime el drop ahí)", () => {
    const h = harness();
    h.gesture.down(nuevo, { x: 0, y: 0 });
    h.gesture.move({ x: 100, y: 0 }, true);
    h.gesture.up();
    expect(h.log).toContain("mover:100,0:paleta");
  });

  it("`armed()` es cierto DESDE el `down`: es lo que le quita la selección al navegador", () => {
    // Esperar a `active()` llegaría tarde: el navegador empieza a seleccionar texto en el mismo
    // `pointerdown`, así que para cuando el gesto supera el umbral ya hay medio párrafo en azul —
    // y Chrome convierte esa selección en su propio arrastre nativo, que mata el del editor.
    const h = harness();
    expect(h.gesture.armed()).toBe(false);
    h.gesture.down(nuevo, { x: 0, y: 0 });
    expect(h.gesture.armed()).toBe(true);
    expect(h.gesture.active()).toBe(false); // todavía no es un arrastre, pero ya hay dedo puesto
    h.gesture.up();
    expect(h.gesture.armed()).toBe(false);
  });

  it("avisa UNA sola vez de que el gesto se convirtió en arrastre", () => {
    // De ese aviso cuelgan el `user-select: none` y el borrado de la selección: repetirlo por
    // cada movimiento sería trabajo por fotograma, y no darlo deja el navegador con su gesto.
    const inicios: number[] = [];
    const frames: Array<() => void> = [];
    const g = createPointerGesture<number>({
      createSession: () => 1,
      moveSession: () => {},
      dropSession: () => {},
      cancelSession: () => {},
      scheduleFrame: (cb) => frames.push(cb),
      cancelFrame: () => {},
      onSessionStart: () => inicios.push(1),
    });
    g.down(nuevo, { x: 0, y: 0 });
    expect(inicios).toHaveLength(0); // pulsar no es arrastrar
    g.move({ x: 3, y: 0 });
    g.up();
    expect(inicios).toHaveLength(0); // un tap tampoco
    g.down(nuevo, { x: 0, y: 0 });
    g.move({ x: 100, y: 0 });
    g.move({ x: 200, y: 0 });
    g.up();
    expect(inicios).toHaveLength(1);
  });

  it("`active()` solo es cierto con un arrastre vivo — el autoscroll depende de eso", () => {
    const h = harness();
    expect(h.gesture.active()).toBe(false);
    h.gesture.down(nuevo, { x: 0, y: 0 });
    expect(h.gesture.active()).toBe(false); // pulsar no es arrastrar
    h.gesture.move({ x: 300, y: 0 });
    h.tick();
    expect(h.gesture.active()).toBe(true);
    h.gesture.up();
    expect(h.gesture.active()).toBe(false);
  });
});
