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

  /* ---------------- el fantasma que SIGUE AL CURSOR ---------------- */

  // Se mueve escribiendo en el DOM, no por estado de React: un `setState` por cada `pointermove`
  // pondría a re-renderizar el árbol del editor sesenta veces por segundo para mover una etiqueta.
  const ghostRef = React.useRef<HTMLDivElement | null>(null);
  /** Último punto del puntero en coordenadas del documento PADRE (donde vive el fantasma). */
  const parentPointRef = React.useRef<DndPoint | null>(null);
  /** Qué se está arrastrando, para poder ponerle nombre al fantasma. */
  const dragSourceRef = React.useRef<{ kind: "new"; type: string } | { kind: "existing"; nodeId: string } | null>(null);

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
      onSessionStart: () => {
        showGhost();
        // Si el navegador alcanzó a pintar algo en azul antes del umbral, se borra: durante un
        // arrastre de bloques no hay ninguna selección de texto que tenga sentido.
        frameWin?.getSelection?.()?.removeAllRanges();
        parentDoc.defaultView?.getSelection?.()?.removeAllRanges();
        setDragging(true);
      },
    });

    let scrollRaf: number | null = null;

    /**
     * QUITARLE AL NAVEGADOR SU GESTO. Al pulsar sobre un bloque, el navegador cree que empiezas a
     * seleccionar texto: pinta la selección y, si sigues arrastrando, la convierte en su PROPIO
     * drag nativo — que cancela los eventos de puntero y deja el arrastre del editor muerto a
     * medias. Es literalmente lo que se veía: "agarro un bloque y sale como si seleccionara texto".
     *
     * `user-select: none` mientras dura el gesto lo impide de raíz (sin selección no hay nada que
     * arrastrar), y el cursor pasa a "grabbing" para que se vea que el editor sí tiene el gesto.
     * Se aplica a los DOS documentos: la paleta vive en el padre y su etiqueta también se seleccionaba.
     */
    /**
     * QUÉ estás arrastrando, escrito con todas las letras junto al cursor.
     *
     * Sin esto el arrastre era invisible: el hueco de destino aparecía en el lienzo, pero de la
     * cosa arrastrada no había ni rastro — al agarrar un bloque no pasaba, aparentemente, nada.
     * Vive en el documento PADRE (tiene que poder viajar por encima de la paleta y del lienzo) y
     * es `pointer-events: none`, así que no se interpone en el hit-test que resuelve el destino.
     */
    const labelOf = (): string => {
      const src = dragSourceRef.current;
      if (!src) return "";
      const type =
        src.kind === "new" ? src.type : (handle.getDoc().nodes[src.nodeId]?.type ?? "");
      return registry.get(type)?.label || type || "Bloque";
    };

    const showGhost = () => {
      const el = ghostRef.current;
      if (!el) return;
      el.textContent = labelOf();
      el.style.display = "block";
      moveGhost();
    };

    const moveGhost = () => {
      const el = ghostRef.current;
      const p = parentPointRef.current;
      if (!el || !p) return;
      // +14/+10: el fantasma va al lado del cursor, no debajo — tapar el punto exacto de suelta
      // es justo lo que no puede hacer.
      el.style.transform = `translate3d(${Math.round(p.x + 14)}px, ${Math.round(p.y + 10)}px, 0)`;
    };

    const hideGhost = () => {
      const el = ghostRef.current;
      if (el) el.style.display = "none";
    };

    const setDragging = (on: boolean) => {
      if (!on) hideGhost();
      for (const el of [frameDocument.documentElement, parentDoc.documentElement]) {
        el.style.userSelect = on ? "none" : "";
        el.style.cursor = on ? "grabbing" : "";
      }
    };

    /** Cancela el gesto NATIVO del navegador (selección y arrastre propio) mientras haya dedo puesto. */
    const suppressNative = (e: Event) => {
      if (gesture.armed()) e.preventDefault();
    };

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

    /** Inversa de `toFramePoint`: del sistema del iframe al del documento padre. */
    const toParentPoint = (p: DndPoint): DndPoint | null => {
      const iframe = canvas.getFrameElement();
      if (!iframe) return null;
      const rect = iframe.getBoundingClientRect();
      const scale = iframe.clientWidth > 0 ? rect.width / iframe.clientWidth : 1;
      return { x: rect.left + p.x * scale, y: rect.top + p.y * scale };
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
      // El fantasma vive en el padre: se guarda el punto en SUS coordenadas. Desde dentro del
      // iframe hay que deshacer el desplazamiento y la escala del previsualizador de dispositivo.
      parentPointRef.current = fromParent ? { x: pe.clientX, y: pe.clientY } : toParentPoint(p);
      moveGhost();
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
      dragSourceRef.current = { kind: "existing", nodeId: id };
      parentPointRef.current = toParentPoint({ x: pe.clientX, y: pe.clientY });
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
      dragSourceRef.current = { kind: "new", type };
      parentPointRef.current = { x: pe.clientX, y: pe.clientY };
      gesture.down({ kind: "new", type }, p);
    };

    const onUp = () => {
      gesture.up();
      stopScroll();
      setDragging(false);
    };

    const onKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== "Escape") return;
      if (!gesture.active() && !gesture.point()) return;
      gesture.cancel();
      stopScroll();
      setDragging(false);
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
    for (const doc of [frameDocument, parentDoc]) {
      doc.addEventListener("selectstart", suppressNative, true);
      doc.addEventListener("dragstart", suppressNative, true);
    }

    return () => {
      frameDocument.removeEventListener("pointerdown", onFrameDown, true);
      parentDoc.removeEventListener("pointerdown", onParentDown, true);
      frameDocument.removeEventListener("pointermove", moveFromFrame, true);
      parentDoc.removeEventListener("pointermove", moveFromParent, true);
      frameDocument.removeEventListener("pointerup", onUp, true);
      parentDoc.removeEventListener("pointerup", onUp, true);
      frameDocument.removeEventListener("keydown", onKeyDown, true);
      parentDoc.removeEventListener("keydown", onKeyDown, true);
      for (const doc of [frameDocument, parentDoc]) {
        doc.removeEventListener("selectstart", suppressNative, true);
        doc.removeEventListener("dragstart", suppressNative, true);
      }
      setDragging(false);
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
    <>
      <div data-wjs-dnd-live="" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {/* `aria-hidden`: es feedback visual del ratón; a quien mueve bloques con el teclado le habla
          la región viva de arriba. Fijo respecto al viewport y fuera del flujo: no empuja nada. */}
      <div
        ref={ghostRef}
        data-wjs-dnd-ghost=""
        aria-hidden="true"
        style={{ display: "none", position: "fixed", left: 0, top: 0, zIndex: 2147483000, pointerEvents: "none" }}
        className="rounded-md border border-[var(--ed-primary)] bg-[var(--ed-surface-container-highest)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--ed-on-surface)] shadow-lg"
      />
    </>
  );
}
