"use client";
/**
 * Verso DnD — driver de sensores (F2). Vive en la capa de chrome del documento
 * PADRE (hermano del iframe, dentro del provider de FrameController) y emite
 * SOLO comandos: setDragPreview en cada tick, UNA transact en el drop, y los
 * moveNode del modo teclado. Toda la lógica computable vive en driverCore.ts /
 * session.ts (puras, testeadas sin DOM); aquí solo está el cableado DOM real:
 *
 * - Sensor de puntero: pointerdown capture en el doc del iframe (bloques, vía
 *   data-wjs-block-id) o en el doc padre (paleta, vía data-wjs-palette-type);
 *   umbral de 5px → sesión. pointermove/up en AMBOS documentos — al arrastrar
 *   desde la paleta el padre deja de ver eventos cuando el puntero entra al
 *   iframe (y viceversa), por eso los dos. Los eventos del padre se traducen
 *   con el offset del iframe y la escala del device-preview (rect visual /
 *   tamaño CSS real del iframe).
 * - Cada move se batchea por rAF; el tick construye el ResolveDragInput con
 *   buildDragLayout (GeometryStore para bloques, medición directa de los
 *   [data-wjs-slot] visibles, computedStyle cacheado por elemento para
 *   flow/dir) y delega en la sesión.
 * - Autoscroll: proximidad <150px a los bordes del viewport del iframe →
 *   scroll continuo proporcional vía rAF mientras la sesión siga viva.
 * - Escape cancela (solo limpia el preview). TECLADO: M o Ctrl/Cmd+Shift+Flecha
 *   con un bloque seleccionado → modo mover (createKeyboardMover) con anuncio
 *   en el live-region aria-live de este componente.
 */
import React from "react";
import { cancelFrame, scheduleFrame } from "../frameScheduler";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import type { DndPoint, TextDir, ZoneFlow, ZoneGeom } from "@/lib/verso/dnd/types";
import { useVersoCanvas } from "../canvas/FrameController";
import { nodeKeyFromTarget } from "../render/nodeKey";
import type { GeometryStore } from "../overlay/GeometryStore";
import {
  autoscrollVelocity,
  blockRectToDndRect,
  buildDragLayout,
  createKeyboardMover,
  createPointerGesture,
  slotAttrValue,
  toFramePoint,
  type SlotInfo,
} from "./driverCore";
import { createDragSession, type DragSession } from "./session";

export interface DnDDriverProps {
  handle: EditorHandle;
  registry: BlockRegistry;
  geometry: GeometryStore;
  /** Documento del iframe (null hasta onFrameReady) — mismo canal que OverlayLayer. */
  frameDocument: Document | null;
}

/** flow/dir de un slot desde su estilo computado (spec §3.1 y §3.6 vía computedStyle). */
function slotStyleOf(cs: CSSStyleDeclaration): { flow: ZoneFlow; dir: TextDir } {
  let flow: ZoneFlow = "column";
  if (cs.display === "grid" || cs.display === "inline-grid") flow = "grid";
  else if ((cs.display === "flex" || cs.display === "inline-flex") && cs.flexDirection.startsWith("row")) {
    flow = "row";
  }
  return { flow, dir: cs.direction === "rtl" ? "rtl" : "ltr" };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

export default function DnDDriver({ handle, registry, geometry, frameDocument }: DnDDriverProps) {
  const canvas = useVersoCanvas();
  const [announcement, setAnnouncement] = React.useState("");
  const announce = React.useCallback((message: string) => setAnnouncement(message), []);

  /* ---------------- layout provider (cacheado por snapshot) ---------------- */

  // computedStyle de cada elemento de slot, cacheado por elemento (el estilo de
  // layout de un slot no cambia durante un drag; un remount trae elemento nuevo).
  const slotStyleCacheRef = React.useRef(new WeakMap<Element, { flow: ZoneFlow; dir: TextDir }>());
  const layoutCacheRef = React.useRef<{ rects: unknown; doc: unknown; layout: ZoneGeom | null } | null>(null);

  const getLayout = React.useCallback((): ZoneGeom | null => {
    if (!frameDocument) return null;
    const win = frameDocument.defaultView;
    if (!win) return null;
    const rects = geometry.getRects();
    const doc = handle.getDoc();
    const cached = layoutCacheRef.current;
    // getRects() solo cambia de referencia cuando algún rect cambió (scroll/
    // resize/mutación invalidan): cachear por (rects, doc) mantiene el memo por
    // referencia del propio resolutor (flatten se paga una vez por layout).
    if (cached && cached.rects === rects && cached.doc === doc) return cached.layout;

    const slotEls = new Map<string, Element>();
    frameDocument.querySelectorAll("[data-wjs-slot]").forEach((el) => {
      const key = el.getAttribute("data-wjs-slot");
      if (key) slotEls.set(key, el);
    });
    const getSlotInfo = (parentId: string, slotKey: string): SlotInfo | null => {
      const el = slotEls.get(slotAttrValue(parentId, slotKey));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return null; // slot no visible
      let style = slotStyleCacheRef.current.get(el);
      if (!style) {
        style = slotStyleOf(win.getComputedStyle(el));
        slotStyleCacheRef.current.set(el, style);
      }
      return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, flow: style.flow, dir: style.dir };
    };
    const getBlockRect = (id: string) => {
      const b = rects.get(id);
      return b ? blockRectToDndRect(b) : null;
    };
    const layout = buildDragLayout({ doc, registry, getBlockRect, getSlotInfo });
    layoutCacheRef.current = { rects, doc, layout };
    return layout;
  }, [frameDocument, geometry, handle, registry]);

  /* ---------------- sensor de puntero + autoscroll + Escape ---------------- */

  React.useEffect(() => {
    if (!frameDocument) return;
    const parentDoc = document;
    const frameWin = frameDocument.defaultView;

    // EL GESTO vive en driverCore (`createPointerGesture`), puro y probado en node: pulsar, mover,
    // soltar y la decisión de si hubo arrastre. Aquí queda SOLO el cableado DOM — traducir eventos
    // a puntos del iframe y decidir qué es un origen arrastrable. Estaba todo junto, y por eso el
    // fallo que se midió en el navegador (soltar antes de que pasara un fotograma perdía el
    // arrastre) no lo veía ningún test.
    const gesture = createPointerGesture<DragSession>({
      createSession: (source, startPoint) =>
        createDragSession({ handle, registry, getLayout }, source, startPoint),
      moveSession: (s, point, over) => s.move(point, { pointerOverDrawer: over }),
      dropSession: (s) => s.drop(),
      cancelSession: (s) => s.cancel(),
      scheduleFrame,
      cancelFrame,
    });

    let scrollRaf: number | null = null;

    // Aritmética pura en driverCore.toFramePoint (testeada con escala 0.75):
    // la escala se deriva de la propia caja del iframe (rect.width/clientWidth),
    // exacta bajo el transform: scale() del device-preview — ver frameScaleOf.
    const eventToFramePoint = (e: PointerEvent, fromParent: boolean): DndPoint | null => {
      if (!fromParent) return { x: e.clientX, y: e.clientY };
      const iframe = canvas.getFrameElement();
      if (!iframe) return null;
      const rect = iframe.getBoundingClientRect();
      return toFramePoint(e.clientX, e.clientY, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        clientWidth: iframe.clientWidth,
      });
    };

    const stopScroll = () => {
      if (scrollRaf !== null) {
        cancelFrame(scrollRaf);
        scrollRaf = null;
      }
    };

    const stepScroll = () => {
      scrollRaf = null;
      const point = gesture.point();
      if (!gesture.active() || !point || !frameWin) return;
      const v = autoscrollVelocity(point, { width: frameWin.innerWidth, height: frameWin.innerHeight });
      if (v.x === 0 && v.y === 0) return;
      frameWin.scrollBy(v.x, v.y);
      scrollRaf = scheduleFrame(stepScroll);
    };

    const makeMoveHandler = (fromParent: boolean) => (e: Event) => {
      const pe = e as PointerEvent;
      const p = eventToFramePoint(pe, fromParent);
      if (!p) return;
      const overDrawer =
        fromParent && !!(pe.target as Element | null)?.closest?.("[data-wjs-palette]");
      gesture.move(p, overDrawer);
      if (gesture.active() && scrollRaf === null) scrollRaf = scheduleFrame(stepScroll);
    };

    const onFrameDown = (e: Event) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0) return;
      // Edición inline activa: arrastrar para SELECCIONAR texto dentro del
      // contenteditable de Tiptap no debe arrancar un drag de bloque.
      if (isEditableTarget(pe.target)) return;
      // The STORE key: `geometry.getRect` is filled under the key VersoBlock renders with, and the
      // drag source becomes a nodeId the transaction has to resolve (see render/nodeKey.ts).
      const id = nodeKeyFromTarget(pe.target);
      if (!id) return;
      const rect = geometry.getRect(id);
      gesture.down(
        { kind: "existing", nodeId: id, originRect: rect ? blockRectToDndRect(rect) : null },
        { x: pe.clientX, y: pe.clientY },
      );
    };

    const onParentDown = (e: Event) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0) return;
      const item = (pe.target as Element | null)?.closest?.("[data-wjs-palette-type]");
      const type = item?.getAttribute("data-wjs-palette-type");
      if (!type) return;
      const p = eventToFramePoint(pe, true);
      if (!p) return;
      gesture.down({ kind: "new", type }, p);
    };

    const onUp = () => {
      gesture.up();
      stopScroll();
    };

    const onKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== "Escape") return;
      if (!gesture.active() && !gesture.point()) return;
      gesture.cancel();
      stopScroll();
      ke.stopPropagation();
    };

    const moveFromFrame = makeMoveHandler(false);
    const moveFromParent = makeMoveHandler(true);

    frameDocument.addEventListener("pointerdown", onFrameDown, true);
    parentDoc.addEventListener("pointerdown", onParentDown, true);
    frameDocument.addEventListener("pointermove", moveFromFrame, true);
    parentDoc.addEventListener("pointermove", moveFromParent, true);
    frameDocument.addEventListener("pointerup", onUp, true);
    parentDoc.addEventListener("pointerup", onUp, true);
    frameDocument.addEventListener("keydown", onKeyDown, true);
    parentDoc.addEventListener("keydown", onKeyDown, true);

    return () => {
      frameDocument.removeEventListener("pointerdown", onFrameDown, true);
      parentDoc.removeEventListener("pointerdown", onParentDown, true);
      frameDocument.removeEventListener("pointermove", moveFromFrame, true);
      parentDoc.removeEventListener("pointermove", moveFromParent, true);
      frameDocument.removeEventListener("pointerup", onUp, true);
      parentDoc.removeEventListener("pointerup", onUp, true);
      frameDocument.removeEventListener("keydown", onKeyDown, true);
      parentDoc.removeEventListener("keydown", onKeyDown, true);
      gesture.cancel();
      stopScroll();
    };
  }, [frameDocument, canvas, handle, registry, geometry, getLayout]);

  /* ---------------- teclado: modo mover + live-region ---------------- */

  const mover = React.useMemo(
    () => createKeyboardMover({ handle, registry, announce }),
    [handle, registry, announce],
  );

  React.useEffect(() => {
    const targets: Document[] = [document];
    if (frameDocument) targets.push(frameDocument);
    const onKey = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (isEditableTarget(ke.target)) return;
      if (mover.handleKey(ke)) {
        ke.preventDefault();
        ke.stopPropagation();
      }
    };
    for (const t of targets) t.addEventListener("keydown", onKey, true);
    return () => {
      for (const t of targets) t.removeEventListener("keydown", onKey, true);
    };
  }, [frameDocument, mover]);

  // Live-region del overlay: anuncia los movimientos del modo teclado.
  return (
    <div data-wjs-dnd-live="" role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  );
}
