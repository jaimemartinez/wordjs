"use client";
/**
 * Verso — render de un SLOT del documento en el canvas del editor.
 *
 * Contrato de DOM (idéntico a ContentRenderer.slotOf y a SlotRender de Puck):
 * UN solo <div> que envuelve los hijos, cuyo className lo decide el bloque
 * contenedor (el grid/flex vive en este wrapper, no en el contenedor). El div
 * estampa `data-wjs-slot="<nodeId>:<slotKey>"` para que overlay/DnD resuelvan
 * la zona por atributo.
 *
 * dragPreview (estado del store, ver types.ts): cuando apunta a un slot, el
 * documento se pinta CON el item virtualmente colocado — `existing` se retira
 * de su posición actual y se pinta en la de destino; `new` pinta un fantasma
 * (`data-verso-ghost`) — SIN mutar el doc (el commit real llega por comandos
 * en el drop). La suscripción usa un selector "concernido": mientras el
 * preview no afecte a ESTE slot (ni como destino ni como origen del nodo
 * movido) la slice es null y el slot no re-renderiza en cada tick del drag.
 */
import React, { useCallback } from "react";
import type { DragPreview, VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice, useVersoRenderContext } from "./context";
import VersoBlock from "./VersoBlock";

export interface VersoSlotProps {
  /** Clave interna del nodo dueño del slot (ROOT_ID para la raíz). */
  parentId: string;
  slotKey: string;
  /** Hijos según el doc (claves internas), en orden. */
  childIds: string[];
  className?: string;
}

export type SlotEntry = { kind: "node"; id: string } | { kind: "ghost"; type: string };

/**
 * Lista efectiva de entradas del slot bajo un dragPreview. Pura y exportada
 * para test directo. Reglas:
 * - `existing`: el nodo movido se FILTRA de la lista (esté donde esté) y, si
 *   este slot es el destino, se reinserta en targetIndex (clampeado sobre la
 *   lista ya filtrada — semántica lista-sin-el-item, como el editor actual).
 * - `new`: si este slot es el destino, se inserta un fantasma en targetIndex.
 * - preview null (o que no concierne a este slot): la lista del doc tal cual.
 */
export function slotEntries(
  childIds: string[],
  parentId: string,
  slotKey: string,
  preview: DragPreview | null,
): SlotEntry[] {
  let ids = childIds;
  if (preview && preview.source.kind === "existing") {
    const moved = preview.source.nodeId;
    if (ids.includes(moved)) ids = ids.filter((id) => id !== moved);
  }
  const entries: SlotEntry[] = ids.map((id) => ({ kind: "node", id }));
  if (preview && preview.targetParentId === parentId && preview.targetSlotKey === slotKey) {
    const index = Math.max(0, Math.min(preview.targetIndex, entries.length));
    const entry: SlotEntry =
      preview.source.kind === "existing"
        ? { kind: "node", id: preview.source.nodeId }
        : { kind: "ghost", type: preview.source.type };
    entries.splice(index, 0, entry);
  }
  return entries;
}

/** dragPreview solo si concierne a este slot (destino, u origen del nodo movido). */
function useConcernedPreview(parentId: string, slotKey: string, childIds: string[]): DragPreview | null {
  const { handle } = useVersoRenderContext();
  const selector = useCallback(
    (s: VersoEditorState): DragPreview | null => {
      const p = s.dragPreview;
      if (!p) return null;
      const isTarget = p.targetParentId === parentId && p.targetSlotKey === slotKey;
      const holdsSource = p.source.kind === "existing" && childIds.includes(p.source.nodeId);
      return isTarget || holdsSource ? p : null;
    },
    [parentId, slotKey, childIds],
  );
  return useStoreSlice(handle, selector);
}

/**
 * EL HUECO ES EL BLOQUE DE VERDAD, no un rectángulo de rayas.
 *
 * Mientras arrastras, el sitio donde va a caer el bloque enseña el bloque MISMO, renderizado con su
 * propio componente y sus props por defecto. Aquí es donde eso sale gratis y exacto: estamos dentro
 * del árbol del lienzo, así que el componente tiene su contexto, sus estilos y su tipografía sin
 * copiar nada — cualquier intento de "previsualizar" fuera del iframe acaba peleándose con hojas de
 * estilo prestadas.
 *
 * Es chrome de AUTORÍA: `aria-hidden`, sin eventos de puntero (no debe robarle el hit-test al
 * resolutor) y translúcido, para que se lea como "esto va a quedar aquí" y no como contenido ya
 * puesto. Vive solo en el editor; el renderizador público no pasa por aquí.
 */
function GhostPreview({ type }: { type: string }) {
  const { registry, componentMap } = useVersoRenderContext();
  const Component = componentMap[type];
  const def = registry.get(type);
  if (!Component || !def) return <GhostFallback />;

  const props: Record<string, unknown> = { ...(def.defaultProps ?? {}), isEditing: true };
  // Un bloque contenedor pide funciones de slot; en una vista previa no hay hijos que pintar.
  for (const [key, field] of Object.entries(def.fields ?? {})) {
    if ((field as { type?: string } | undefined)?.type === "slot") props[key] = () => null;
  }
  return <Component {...props} />;
}

/** Lo de siempre cuando el bloque no se puede pintar: un hueco con su forma. */
function GhostFallback() {
  return (
    <div className="min-h-10 rounded border-2 border-dashed border-[var(--ed-primary)] bg-[var(--ed-surface-container-high)] opacity-60" />
  );
}

/**
 * Red de seguridad: un bloque puede reventar al pintarse con props por defecto (le falta un dato
 * resuelto, un plugin a medias…). Sin esto, ese fallo derribaría el LIENZO ENTERO en mitad de un
 * arrastre — un precio absurdo por una vista previa. Se cae al hueco de rayas y no se entera nadie.
 */
class GhostBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <GhostFallback /> : this.props.children;
  }
}

/**
 * Fantasma del item nuevo durante el drag. Sin texto propio (aria-hidden: es feedback puramente
 * visual); el tipo viaja en data-verso-ghost-type para overlay/tests y para que el fantasma del
 * cursor pueda clonar ESTO — el mismo HTML, no una imitación.
 */
function GhostPlaceholder({ type }: { type: string }) {
  return (
    <div
      data-verso-ghost=""
      data-verso-ghost-type={type}
      aria-hidden="true"
      className="pointer-events-none opacity-70 outline-2 outline-dashed outline-[var(--ed-primary)]"
    >
      <GhostBoundary>
        <GhostPreview type={type} />
      </GhostBoundary>
    </div>
  );
}

/**
 * SUPERFICIE DE SUELTA DE UN SLOT VACÍO — sin ella, un contenedor vacío no se puede llenar.
 *
 * El DnD mide el elemento del slot: un slot sin hijos es un `div` sin contenido, y su caja mide
 * CERO de alto. El resolutor contrae además cada candidato 6px por lado antes del hit-test, así que
 * un rectángulo de altura cero no puede contener al puntero — jamás. Y el relleno del contenedor
 * tampoco vale: sobre el "chrome" de un componente que tiene una zona activa, el resolutor devuelve
 * a propósito "sin destino" (regla F-9, réplica fiel del fork, con su caso en el fixture).
 *
 * Entre las dos cosas, una sección recién creada era un agujero negro: se arrastraba un bloque
 * encima y no pasaba nada, sin error ni pista. Medido en el editor real: el slot de una sección
 * vacía ocupaba `113,528 → 1157,528`.
 *
 * Esto es chrome de AUTORÍA, igual que el fantasma del arrastre: vive solo en el lienzo del editor
 * (el renderizador público tiene su propio camino), es `aria-hidden` y desaparece en cuanto el slot
 * tiene un hijo — así que el HTML del sitio no cambia ni un byte.
 */
function EmptySlotDropArea() {
  return (
    <div
      data-verso-empty-slot=""
      aria-hidden="true"
      className="min-h-12 rounded border border-dashed border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]/40"
    />
  );
}

const VersoSlot = React.memo(function VersoSlot({ parentId, slotKey, childIds, className }: VersoSlotProps) {
  const preview = useConcernedPreview(parentId, slotKey, childIds);
  const entries = slotEntries(childIds, parentId, slotKey, preview);
  return (
    <div className={className} data-wjs-slot={`${parentId}:${slotKey}`}>
      {entries.length === 0 ? (
        <EmptySlotDropArea />
      ) : (
        entries.map((entry) =>
          entry.kind === "node" ? (
            <VersoBlock key={entry.id} nodeId={entry.id} />
          ) : (
            <GhostPlaceholder key="verso:ghost" type={entry.type} />
          ),
        )
      )}
    </div>
  );
});

export default VersoSlot;
