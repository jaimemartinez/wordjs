"use client";
/**
 * Verso — render de UN bloque del documento en el canvas.
 *
 * - Se suscribe a SU nodo (useVersoNode → handle.subscribeNode): re-render solo
 *   si su VersoNode cambia de referencia. React.memo corta además la cascada
 *   desde el padre (un setProps en un contenedor no re-pinta a sus hijos).
 * - El wrapper compartido NO se reimplementa: se renderiza SharedBlockShell
 *   (frontend/src/components/content/SharedBlockShell.tsx), que produce las
 *   MISMAS 4 ramas de salida y las 2 capas anim/apariencia con las MISMAS
 *   funciones puras de blockShell.ts (hideClasses/appearanceToStyle, y
 *   animClasses vía AnimatedShell) que usa el sitio público — paridad
 *   canvas↔público por construcción, no por disciplina.
 * - La raíz del bloque estampa data-wjs-block-id={props.id} y registra su
 *   elemento vía onBlockElement(idInterno, el|null) para que overlay/DnD midan
 *   geometría real. Es un <div> real (no display:contents): un elemento sin
 *   caja devuelve rects vacíos y la medición sería imposible — mismo patrón
 *   que el DraggableComponent del editor actual.
 * - componentMap[type] ausente → placeholder <div data-verso-missing> con el
 *   type visible (fail-soft: el doc nunca se pierde por un bloque sin UI).
 */
import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import SharedBlockShell from "@/components/content/SharedBlockShell";
import type { AnimSpec, Appearance, Hide } from "@/components/blocks/blockShell";
import { createInlineMountStore } from "../inline/inlineSession";
import VersoInline from "../inline/VersoInline";
import { INLINE_HOST_SENTINEL } from "../inline/VersoTextSurface";
import {
  selectInlineEditingId,
  useStoreSlice,
  useVersoNode,
  useVersoRenderContext,
  type VersoSlotRender,
} from "./context";
import VersoSlot from "./VersoSlot";

const VersoBlock = React.memo(function VersoBlock({ nodeId }: { nodeId: string }) {
  const ctx = useVersoRenderContext();
  const { handle, registry, componentMap, onBlockElement, editorChrome } = ctx;
  const node = useVersoNode(handle, nodeId);
  // Cambia como mucho dos veces por sesión de edición inline (entrar/salir).
  const inlineEditingId = useStoreSlice(handle, selectInlineEditingId);
  // Declaración inline del nodo cuando ESTE nodo es el activo (referencia
  // estable del registry; solo notifica al entrar/salir del modo inline).
  const inlineStore = useMemo(
    () => createInlineMountStore(handle, registry, nodeId),
    [handle, registry, nodeId],
  );
  const inlineSpec = useSyncExternalStore(
    inlineStore.subscribe,
    inlineStore.getSnapshot,
    inlineStore.getSnapshot,
  );
  const registerElement = useCallback(
    (el: HTMLElement | null) => {
      onBlockElement?.(nodeId, el);
    },
    [onBlockElement, nodeId],
  );

  // Nodo desaparecido (undo/remove entre notificación y render): fail-soft.
  if (!node) return null;

  const props = node.props;
  const Component = componentMap[node.type];

  let content: React.ReactNode;
  if (inlineSpec) {
    // Edición inline declarativa IN-PLACE (F3.5, fix W34-tipografía): el
    // Component real del bloque se sigue renderizando — con la prop inline
    // sustituida por el CENTINELA — y VersoTextSurface (dentro de VersoInline)
    // localiza el elemento del centinela y edita su nodo de texto in situ, de
    // modo que el editable hereda la tipografía real del bloque. El centinela
    // es CONSTANTE: los commits parciales re-renderizan el Component con props
    // idénticas y React no toca el DOM que posee el contenteditable. El cambio
    // de forma del árbol (Fragment ↔ Component) fuerza remount limpio al
    // entrar y al salir de la edición.
    const passProps: Record<string, unknown> = {
      ...props,
      isEditing: true,
      [inlineSpec.prop]: INLINE_HOST_SENTINEL,
    };
    for (const [slotKey, childIds] of Object.entries(node.slots)) {
      const render: VersoSlotRender = (className?: string) => (
        <VersoSlot parentId={node.id} slotKey={slotKey} childIds={childIds} className={className} />
      );
      passProps[slotKey] = render;
    }
    content = (
      <React.Fragment key={`${node.id}:${inlineSpec.prop}`}>
        {Component ? <Component {...passProps} /> : null}
        <VersoInline nodeId={node.id} prop={inlineSpec.prop} schema={inlineSpec.schema} />
      </React.Fragment>
    );
  } else if (Component) {
    // Props del nodo TAL CUAL + una función de slot por cada clave de slot
    // (contrato (className)=>ReactNode) + isEditing, como el config actual.
    const passProps: Record<string, unknown> = { ...props, isEditing: true };
    for (const [slotKey, childIds] of Object.entries(node.slots)) {
      const render: VersoSlotRender = (className?: string) => (
        <VersoSlot parentId={node.id} slotKey={slotKey} childIds={childIds} className={className} />
      );
      passProps[slotKey] = render;
    }
    content = <Component {...passProps} />;
  } else {
    content = (
      <div
        data-verso-missing={node.type}
        role="note"
        className="rounded border border-dashed border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-3 py-2 text-xs text-[var(--ed-on-surface-variant)]"
      >
        Bloque sin componente registrado: <code>{node.type}</code>
      </div>
    );
  }

  // editorChrome: durante la edición inline se atenúan los DEMÁS bloques para
  // enfocar el activo. Solo clases tailwind ya existentes; sin CSS nuevo.
  const dimmed = !!editorChrome && inlineEditingId !== null && inlineEditingId !== node.id;

  return (
    <div
      data-wjs-block-id={props.id}
      ref={registerElement}
      className={dimmed ? "opacity-40 transition-opacity" : undefined}
    >
      <SharedBlockShell
        hide={props.hide as Hide | undefined}
        anim={props.anim as AnimSpec | undefined}
        look={props.look as Appearance | undefined}
        ix={props.ix}
      >
        {content}
      </SharedBlockShell>
    </div>
  );
});

export default VersoBlock;
