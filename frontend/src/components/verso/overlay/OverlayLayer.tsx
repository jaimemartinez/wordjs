"use client";
/**
 * Verso — capa de overlay en el DOCUMENTO PADRE (F2).
 *
 * <div data-wjs-overlay-layer>: position:absolute inset-0, overflow:hidden,
 * pointer-events:none, z-index:2 — HERMANA del iframe dentro del contenedor del
 * canvas (mismo contenedor escalado del device-preview → coordenadas 1:1 con
 * los rects del GeometryStore, sin término de escala). PROHIBIDO cualquier
 * atributo *overlay-portal* en la capa: la trampa documentada del editor actual
 * (data-puck-overlay-portal en la capa se come el scroll del canvas).
 *
 * Contiene: SelectionOutline (borde del seleccionado, sigue el scroll porque el
 * GeometryStore re-mide en scroll capture), HoverOutline, InsertionIndicator
 * (línea en el slot/índice del dragPreview) y el ActionBar flotante (el ÚNICO
 * elemento con pointer-events-auto). El hover se detecta con listeners sobre el
 * documento del iframe (mouseover capture → closest [data-wjs-block-id]).
 */
import React from "react";
import type { DragPreview, VersoDoc, VersoEditorState } from "@/lib/verso/types";
import { ROOT_ID } from "@/lib/verso/types";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import { useStoreSlice } from "../render/context";
import { slotEntries } from "../render/VersoSlot";
import ActionBar from "./ActionBar";
import type { BlockRect, GeometryStore } from "./GeometryStore";

const selectSelectedId = (s: VersoEditorState): string | null => s.selection.nodeId;
const selectDragPreview = (s: VersoEditorState): DragPreview | null => s.dragPreview;
const selectInlineEditingId = (s: VersoEditorState): string | null => s.inlineEditingId;

function useGeometryRects(geometry: GeometryStore): ReadonlyMap<string, BlockRect> {
    const subscribe = React.useCallback(
        (onChange: () => void) => geometry.subscribe(() => onChange()),
        [geometry],
    );
    const getSnapshot = React.useCallback(() => geometry.getRects(), [geometry]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Id de bloque bajo el puntero dentro del documento del iframe (data-wjs-block-id). */
function useHoveredBlockId(frameDocument: Document | null): string | null {
    const [hovered, setHovered] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!frameDocument) return;
        const onOver = (e: Event) => {
            const target = e.target as Element | null;
            const el = target?.closest?.("[data-wjs-block-id]") ?? null;
            setHovered(el ? el.getAttribute("data-wjs-block-id") : null);
        };
        const onLeave = () => setHovered(null);
        frameDocument.addEventListener("mouseover", onOver, true);
        frameDocument.addEventListener("mouseleave", onLeave, true);
        return () => {
            frameDocument.removeEventListener("mouseover", onOver, true);
            frameDocument.removeEventListener("mouseleave", onLeave, true);
            setHovered(null);
        };
    }, [frameDocument]);
    return hovered;
}

/**
 * Rect de la línea de inserción del dragPreview. Pura (exportada para test
 * futuro): usa la lista EFECTIVA del slot (slotEntries, la misma del render)
 * y los rects medidos. Ghost sin rect propio → top del siguiente nodo con
 * rect, o bottom del anterior; sin referencia medible → null (fail-soft).
 */
export function insertionLineRect(
    doc: VersoDoc,
    rects: ReadonlyMap<string, BlockRect>,
    preview: DragPreview,
): { x: number; y: number; width: number } | null {
    const siblings =
        preview.targetParentId === ROOT_ID
            ? doc.rootChildren
            : (doc.nodes[preview.targetParentId]?.slots[preview.targetSlotKey] ?? []);
    const entries = slotEntries(siblings, preview.targetParentId, preview.targetSlotKey, preview);
    const insertedAt = Math.max(0, Math.min(preview.targetIndex, entries.length - 1));
    const rectOf = (i: number): BlockRect | null => {
        const entry = entries[i];
        return entry && entry.kind === "node" ? (rects.get(entry.id) ?? null) : null;
    };
    const own = rectOf(insertedAt);
    if (own) return { x: own.x, y: own.y, width: own.width };
    for (let i = insertedAt + 1; i < entries.length; i++) {
        const r = rectOf(i);
        if (r) return { x: r.x, y: r.y, width: r.width };
    }
    for (let i = insertedAt - 1; i >= 0; i--) {
        const r = rectOf(i);
        if (r) return { x: r.x, y: r.y + r.height, width: r.width };
    }
    return null;
}

function Outline({ rect, className }: { rect: BlockRect; className: string }) {
    return (
        <div
            className={`pointer-events-none absolute ${className}`}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
    );
}

export interface OverlayLayerProps {
    handle: EditorHandle;
    registry: BlockRegistry;
    geometry: GeometryStore;
    /** Documento del iframe (null hasta onFrameReady); alimenta el hover. */
    frameDocument: Document | null;
}

export default function OverlayLayer({ handle, registry, geometry, frameDocument }: OverlayLayerProps) {
    const rects = useGeometryRects(geometry);
    const selectedId = useStoreSlice(handle, selectSelectedId);
    const dragPreview = useStoreSlice(handle, selectDragPreview);
    const inlineEditingId = useStoreSlice(handle, selectInlineEditingId);
    const hoveredId = useHoveredBlockId(frameDocument);

    // Un cambio de doc/preview reflowa el canvas sin disparar ResizeObserver
    // (mover un bloque no cambia su tamaño): invalidar geometría en cada
    // notificación del store, batcheado por el rAF del propio GeometryStore.
    React.useEffect(
        () => handle.subscribe(() => geometry.invalidate()),
        [handle, geometry],
    );

    const selectedRect = selectedId ? rects.get(selectedId) : undefined;
    const hoveredRect =
        hoveredId && hoveredId !== selectedId ? rects.get(hoveredId) : undefined;
    const line = dragPreview ? insertionLineRect(handle.getDoc(), rects, dragPreview) : null;

    return (
        <div
            data-wjs-overlay-layer=""
            className="pointer-events-none absolute inset-0 z-[2] overflow-hidden"
        >
            {hoveredRect && (
                <Outline
                    rect={hoveredRect}
                    className="border border-dashed border-[var(--ed-primary,#2563eb)] opacity-60"
                />
            )}
            {selectedRect && (
                <Outline rect={selectedRect} className="border-2 border-[var(--ed-primary,#2563eb)]" />
            )}
            {line && (
                <div
                    data-wjs-insertion-indicator=""
                    className="pointer-events-none absolute h-0.5 rounded bg-[var(--ed-primary,#2563eb)]"
                    style={{ left: line.x, top: Math.max(0, line.y - 1), width: line.width }}
                />
            )}
            {/* F6 (cazado por el e2e del BubbleMenu): el ActionBar flota EXACTAMENTE
                donde el bubble de la sesión inline (ambos sobre el bloque/selección) y,
                al vivir en el documento PADRE, se queda con TODOS los clicks dirigidos
                al bubble del iframe — y cualquier click sobre él es un outside-press
                que cierra la sesión. Durante una sesión inline el ActionBar se OCULTA:
                sus acciones (mover/duplicar/eliminar) no aplican mientras se edita texto. */}
            {selectedId && selectedRect && inlineEditingId === null && (
                <ActionBar handle={handle} registry={registry} nodeId={selectedId} rect={selectedRect} />
            )}
        </div>
    );
}
