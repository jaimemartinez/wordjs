"use client";
/**
 * Verso — punto de entrada del render del documento en el canvas del editor.
 *
 * <EditorRenderer handle registry componentMap/> provee el contexto y pinta el
 * slot raíz (ROOT_ID:ROOT_SLOT) con el mismo mecanismo que cualquier slot
 * anidado: un único div `data-wjs-slot="verso:root:content"` que además sirve
 * de zona raíz para el DnD. Cada hijo es un <VersoBlock nodeId> que se
 * suscribe a SU nodo — ver VersoBlock.tsx/context.ts para el contrato de
 * re-render selectivo y VersoSlot.tsx para el dragPreview.
 *
 * DECISIÓN: el renderer NO se suscribe a registry.version() — no lee
 * definiciones para pintar (eso lo hace componentMap, que es un prop: quien lo
 * derive del registry re-renderiza pasando un mapa nuevo). El registry viaja
 * en el contexto para los consumidores que sí lo necesitan (panel de props,
 * inserción — F2).
 */
import React, { useMemo } from "react";
import { ROOT_ID, ROOT_SLOT } from "@/lib/verso/types";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import {
  selectRootChildren,
  useStoreSlice,
  VersoRenderContext,
  type VersoComponentMap,
  type VersoRenderContextValue,
} from "./context";
import VersoSlot from "./VersoSlot";

export interface EditorRendererProps {
  handle: EditorHandle;
  registry: BlockRegistry;
  componentMap: VersoComponentMap;
  /** Canal de geometría (overlay/DnD): raíz de cada bloque al montar/desmontar. */
  onBlockElement?: (id: string, el: HTMLElement | null) => void;
  /** true → atenúa los bloques no activos durante la edición inline. */
  editorChrome?: boolean;
  /** Clase del wrapper del slot raíz (p.ej. el ancho de página del canvas). */
  rootClassName?: string;
}

export default function EditorRenderer({
  handle,
  registry,
  componentMap,
  onBlockElement,
  editorChrome,
  rootClassName,
}: EditorRendererProps) {
  const rootChildren = useStoreSlice(handle, selectRootChildren);
  const contextValue = useMemo<VersoRenderContextValue>(
    () => ({ handle, registry, componentMap, onBlockElement, editorChrome }),
    [handle, registry, componentMap, onBlockElement, editorChrome],
  );
  return (
    <VersoRenderContext.Provider value={contextValue}>
      <VersoSlot parentId={ROOT_ID} slotKey={ROOT_SLOT} childIds={rootChildren} className={rootClassName} />
    </VersoRenderContext.Provider>
  );
}
