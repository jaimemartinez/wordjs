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
import { createPortal } from "react-dom";
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
  /**
   * EL ELEMENTO agarrado, guardado en el propio `pointerdown`. No se vuelve a buscar por id a
   * propósito: el `nodeId` del store no es el mismo valor que el atributo del DOM (ver
   * render/nodeKey.ts), así que buscarlo por ahí devolvía `null` y el fantasma salía vacío.
   */
  const dragElRef = React.useRef<Element | null>(null);
  /**
   * DÓNDE agarraste el bloque, dentro de él y en píxeles del documento padre. El fantasma cuelga de
   * ese punto: se coge por donde se cogió, como un papel. Anclarlo por su esquina lo dejaba flotando
   * lejos del cursor — medido: 122px a la derecha al agarrar una sección por el centro.
   */
  const grabOffsetRef = React.useRef<DndPoint>({ x: 0, y: 0 });
  /** El portal solo existe en el cliente: el primer render del servidor no tiene `document`. */
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

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
      moveSession: (s, point, over) => {
        s.move(point, { pointerOverDrawer: over });
        // Un bloque NUEVO empieza mostrándose como su tarjeta (todavía no existe en el lienzo). En
        // cuanto el lienzo pinta la vista previa REAL en el hueco de destino, el fantasma la adopta:
        // a partir de ahí lo que llevas en la mano es el bloque, no su tarjeta.
        if (!ghostFromCanvas && dragSourceRef.current?.kind === "new") {
          if (frameDocument.querySelector("[data-verso-ghost]")) {
            ghostFromCanvas = true;
            buildGhost();
            moveGhost();
          }
        }
      },
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
    /** ¿El fantasma ya enseña la vista previa del lienzo (y no la tarjeta de la paleta)? */
    let ghostFromCanvas = false;
    /**
     * Tamaño del fantasma, anotado AL CONSTRUIRLO. Medirlo en cada movimiento leía la caja antes de
     * que el clon estuviera montado, y el anclaje salía por donde no era.
     */
    let ghostSize = { w: 0, h: 0 };
    /** Cuánto se subió el clon dentro de su recorte: el anclaje tiene que descontarlo. */
    let ghostShiftY = 0;

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
     * EL FANTASMA ES EL BLOQUE, no una etiqueta con su nombre.
     *
     * Lo que se arrastra tiene que verse: mientras el arrastre era invisible, agarrar un bloque
     * parecía no hacer nada. Y una pastilla con el nombre tampoco es lo que estás moviendo — así
     * que el fantasma es una COPIA REAL del bloque.
     *
     * El obstáculo es de dónde viven las cosas: el fantasma tiene que poder viajar por encima de la
     * paleta Y del lienzo, así que vive en el documento PADRE… que no tiene la hoja de estilos del
     * sitio. Una copia pelada ahí se vería sin estilo ninguno. Se monta por eso en un SHADOW ROOT
     * que adopta las hojas del iframe: los estilos del lienzo entran, los del editor no se filtran,
     * y ningún id o atributo duplicado queda visible para los selectores del documento.
     *
     * Un bloque NUEVO todavía no existe en el lienzo; ahí lo que estás moviendo es su tarjeta de la
     * paleta, y esa sí vive en el padre: se clona tal cual.
     */
    const CANVAS_GHOST_MAX_H = 220;

    const buildGhost = (): void => {
      const host = ghostRef.current;
      const src = dragSourceRef.current;
      if (!host || !src) return;
      host.replaceChildren();

      if (src.kind === "new") {
        // El lienzo ya pinta el BLOQUE REAL en el hueco de destino: se clona ESE, no una imitación.
        // Hasta que el puntero llega al lienzo no existe todavía, y ahí lo que agarraste es la
        // tarjeta de la paleta — que es exactamente lo que se enseña mientras tanto.
        const enCanvas = frameDocument.querySelector("[data-verso-ghost]");
        if (enCanvas) {
          mountCanvasClone(enCanvas);
          return;
        }
        const clone = dragElRef.current?.cloneNode(true) as HTMLElement | undefined;
        if (!clone) return;
        // Sin el atributo: una copia inerte no debe parecerle a nadie un origen de arrastre.
        clone.removeAttribute("data-wjs-palette-type");
        host.appendChild(clone);
        const cr = dragElRef.current!.getBoundingClientRect();
        ghostSize = { w: Math.round(cr.width), h: Math.round(cr.height) };
        sizeGhostBox();
        return;
      }

      const el = dragElRef.current;
      if (!el) return;
      mountCanvasClone(el);
    };

    /** Clona un elemento DEL LIENZO dentro del fantasma, con sus hojas y sus tokens. */
    const mountCanvasClone = (el: Element): void => {
      const host = ghostRef.current;
      if (!host) return;
      host.replaceChildren();
      const rect = el.getBoundingClientRect();
      const iframe = canvas.getFrameElement();
      const scale =
        iframe && iframe.clientWidth > 0 ? iframe.getBoundingClientRect().width / iframe.clientWidth : 1;

      const shadowHost = parentDoc.createElement("div");
      const shadow = shadowHost.attachShadow({ mode: "open" });
      // Las hojas del lienzo, clonadas: mismo origen, así que el navegador las sirve de su caché.
      for (const node of frameDocument.querySelectorAll('link[rel="stylesheet"], style')) {
        shadow.appendChild(node.cloneNode(true));
      }
      /**
       * LOS TOKENS DEL TEMA, a mano. Las reglas que los declaran son `:root { --wjs-… }`, y `:root`
       * es el elemento raíz del DOCUMENTO: dentro de un shadow root no casa con nada. Sin esto las
       * hojas clonadas están ahí pero cada `var(--wjs-…)` queda sin valor, y el clon sale
       * transparente — se veía el marco del fantasma y dentro, nada.
       */
      const rootStyle = frameDocument.defaultView?.getComputedStyle(frameDocument.documentElement);
      let tokens = "";
      if (rootStyle) {
        for (let i = 0; i < rootStyle.length; i++) {
          const prop = rootStyle.item(i);
          if (prop.startsWith("--")) tokens += `${prop}:${rootStyle.getPropertyValue(prop)};`;
        }
      }

      /**
       * SE RECORTA ALREDEDOR DE DONDE AGARRASTE, no por arriba.
       *
       * Un bloque puede medir 800px: como fantasma hay que recortarlo o taparía media pantalla. Pero
       * recortar los primeros 220px de una sección enseña su RELLENO — el fantasma salía vacío,
       * que es exactamente lo que no debe pasar. Se desplaza el clon para que la banda visible sea
       * la que tenías bajo el cursor.
       */
      const scaleSafe = scale || 1;
      const grabDentro = grabOffsetRef.current.y / scaleSafe; // px del bloque, sin escalar
      const maxShift = Math.max(0, rect.height - CANVAS_GHOST_MAX_H);
      const shift = Math.min(Math.max(0, grabDentro - CANVAS_GHOST_MAX_H / 2), maxShift);
      ghostShiftY = shift * scaleSafe;

      const box = parentDoc.createElement("div");
      box.setAttribute(
        "style",
        `${tokens}width:${Math.round(rect.width)}px;max-height:${CANVAS_GHOST_MAX_H}px;overflow:hidden;` +
          `transform:scale(${scale});transform-origin:top left;` +
          // El fondo del lienzo, para que el clon no dependa de lo que haya detrás del cursor.
          `background:${frameDocument.body ? frameDocument.defaultView!.getComputedStyle(frameDocument.body).backgroundColor : "transparent"};`,
      );
      const inner = parentDoc.createElement("div");
      inner.setAttribute("style", `margin-top:${-Math.round(shift)}px`);
      inner.appendChild(el.cloneNode(true));
      box.appendChild(inner);
      shadow.appendChild(box);
      shadowHost.setAttribute(
        "style",
        `width:${Math.round(rect.width * scale)}px;height:${Math.round(
          Math.min(rect.height, CANVAS_GHOST_MAX_H) * scale,
        )}px;overflow:hidden;`,
      );
      host.appendChild(shadowHost);
      ghostSize = {
        w: Math.round(rect.width * scale),
        h: Math.round(Math.min(rect.height, CANVAS_GHOST_MAX_H) * scale),
      };
      sizeGhostBox();
    };

    /**
     * El contenedor del fantasma se CIÑE a su clon. Sin medidas propias su caja no coincidía con lo
     * que se ve —medido: 735px de ancho para un clon de 496— y el anclaje al punto de agarre caía
     * fuera por la diferencia.
     */
    const sizeGhostBox = () => {
      const el = ghostRef.current;
      if (!el) return;
      el.style.width = ghostSize.w > 0 ? `${ghostSize.w}px` : "";
      el.style.height = ghostSize.h > 0 ? `${ghostSize.h}px` : "";
    };

    const showGhost = () => {
      const el = ghostRef.current;
      if (!el) return;
      buildGhost();
      el.style.display = "block";
      moveGhost();
    };

    const moveGhost = () => {
      const el = ghostRef.current;
      const p = parentPointRef.current;
      if (!el || !p) return;
      // El clon se recorta (un bloque puede medir 800px): si agarraste por debajo del recorte, el
      // desfase se limita a la caja que de verdad existe, o el fantasma saldría disparado.
      const grab = grabOffsetRef.current;
      const dx = ghostSize.w > 0 ? Math.min(grab.x, Math.max(0, ghostSize.w - 8)) : grab.x;
      const dy =
        ghostSize.h > 0
          ? Math.min(Math.max(0, grab.y - ghostShiftY), Math.max(0, ghostSize.h - 8))
          : grab.y;
      el.style.transform = `translate3d(${Math.round(p.x - dx)}px, ${Math.round(p.y - dy)}px, 0)`;
    };

    const hideGhost = () => {
      const el = ghostRef.current;
      if (!el) return;
      el.style.display = "none";
      el.replaceChildren();
      ghostFromCanvas = false;
      ghostSize = { w: 0, h: 0 };
      ghostShiftY = 0;
      el.style.width = "";
      el.style.height = ""; // el clon no sobrevive al gesto: ni memoria ni un DOM viejo en pantalla
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
      const grabbed = (pe.target as Element | null)?.closest?.("[data-wjs-block-id]") ?? null;
      dragElRef.current = grabbed;
      if (grabbed) {
        const gr = grabbed.getBoundingClientRect();
        const iframeEl = canvas.getFrameElement();
        const sc =
          iframeEl && iframeEl.clientWidth > 0
            ? iframeEl.getBoundingClientRect().width / iframeEl.clientWidth
            : 1;
        grabOffsetRef.current = { x: (pe.clientX - gr.left) * sc, y: (pe.clientY - gr.top) * sc };
      }
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
      dragElRef.current = item ?? null;
      const cardRect = item?.getBoundingClientRect();
      grabOffsetRef.current = cardRect
        ? { x: pe.clientX - cardRect.left, y: pe.clientY - cardRect.top }
        : { x: 0, y: 0 };
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
      {/* AL BODY, por portal. Un `position: fixed` se resuelve contra el ancestro TRANSFORMADO más
          cercano, no contra la ventana, y el editor tiene varios por el camino (paneles, el marco
          del lienzo): el fantasma aparecía desplazado cientos de píxeles del cursor — medido, 270px
          a la derecha. Colgando del body no hay ancestro que lo desvíe.
          `aria-hidden`: es feedback visual del ratón; a quien mueve bloques con el teclado le habla
          la región viva de arriba. */}
      {mounted &&
        createPortal(
          <div
            ref={ghostRef}
            data-wjs-dnd-ghost=""
            aria-hidden="true"
            style={{
              display: "none",
              position: "fixed",
              left: 0,
              top: 0,
              zIndex: 2147483000,
              pointerEvents: "none",
              // Translúcido y con sombra: se lee como "esto lo llevas en la mano", no como contenido
              // ya colocado. La rotación mínima es la misma pista, sin marear.
              opacity: 0.85,
              rotate: "-1deg",
              filter: "drop-shadow(0 8px 20px rgba(0,0,0,.35))",
              borderRadius: "6px",
              overflow: "hidden",
              outline: "2px solid var(--ed-primary)",
            }}
          />,
          document.body,
        )}
    </>
  );
}
