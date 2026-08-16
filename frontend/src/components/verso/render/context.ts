"use client";
/**
 * Verso — contexto y hooks de suscripción del renderer del editor.
 *
 * CONTRATO DE RENDIMIENTO (p95 < 16ms): cada bloque se suscribe a SU nodo vía
 * `handle.subscribeNode` (store.ts), que solo notifica cuando ese `VersoNode`
 * cambia de REFERENCIA. `useVersoNode` puentea esa semántica a React con
 * `useSyncExternalStore`: el snapshot ES el nodo, así que React re-renderiza el
 * bloque exactamente cuando el store lo notifica y nunca por cambios de otros
 * nodos. `createNodeStore` queda exportado como par {subscribe,getSnapshot}
 * puro para poder testear la selectividad sin DOM (vitest corre en node).
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type React from "react";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoEditorState, VersoNode } from "@/lib/verso/types";
import type { BlockRegistry } from "@/lib/verso/registry";
import type { IxCompileCtx } from "@/lib/verso/interactions";

/**
 * Contrato de slot — el MISMO de ContentRenderer/TemplateRenderer y del editor
 * actual: una función `(className?) => ReactNode` que envuelve los hijos del
 * slot en UN solo div (el layout de Grid/FlexRow vive en ese wrapper).
 */
export type VersoSlotRender = (className?: string) => React.ReactNode;

/**
 * Props que recibe el componente de un bloque: las props del nodo tal cual
 * (sin los arrays de slot), más una función VersoSlotRender por cada clave de
 * slot, más `isEditing: true`. Los bloques reales de blocks.tsx tipan `any`,
 * así que cualquier componente encaja estructuralmente.
 */
export type VersoBlockProps = Record<string, unknown>;
export type VersoBlockComponent = React.ComponentType<VersoBlockProps>;

/** Mapa type → componente de render. Tipos ausentes → placeholder data-verso-missing. */
export type VersoComponentMap = Record<string, VersoBlockComponent>;

export interface VersoRenderContextValue {
  handle: EditorHandle;
  registry: BlockRegistry;
  componentMap: VersoComponentMap;
  /**
   * Canal de geometría para overlay/DnD: se invoca con el elemento raíz de cada
   * bloque al montar (el) y al desmontar (null). El id es la CLAVE INTERNA del
   * nodo (== props.id salvo ids duplicados corruptos, ver types.ts), que es la
   * que entienden los comandos y el resolutor DnD.
   */
  onBlockElement?: (id: string, el: HTMLElement | null) => void;
  /** true → atenúa los bloques NO activos durante la edición inline. */
  editorChrome?: boolean;
  /**
   * true → hay una sesión de colaboración VIVA sobre este documento (F8.4). Lo consume la edición
   * inline: comitea por pulsación y reconcilia el editable con el texto ajeno ya fusionado. Fuera
   * de una sesión viva no se activa nada de eso — el editor se comporta exactamente como siempre.
   */
  collabLive?: boolean;
  /**
   * Catálogo de preajustes de interacción (sistema + SITIO) con el que el canvas compila. Viaja por
   * el contexto y no por props porque lo necesitan dos consumidores muy separados: el wrapper de
   * cada bloque (para resolver la clase `.wjs-ix-<hash>` de un preajuste del sitio) y los bloques de
   * texto (para saber si su interacción parte el texto en palabras).
   *
   * Sin él, `SharedBlockShell` cae a los preajustes del SISTEMA y un preajuste creado en Ajustes
   * simplemente no se vería en el editor: se vería en el sitio público y no en el lienzo, que es la
   * peor forma posible de fallar.
   */
  ixCtx?: IxCompileCtx;
}

export const VersoRenderContext = createContext<VersoRenderContextValue | null>(null);

export function useVersoRenderContext(): VersoRenderContextValue {
  const value = useContext(VersoRenderContext);
  if (!value) {
    throw new Error("verso: useVersoRenderContext debe usarse dentro de <EditorRenderer>");
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Suscripción por slice (selection/inlineEditing/dragPreview/root).   */
/* ------------------------------------------------------------------ */

/**
 * Suscripción a una slice del estado del editor. `selector` DEBE ser una
 * referencia estable (constante de módulo o memoizada): forma la identidad de
 * la suscripción. El store solo notifica cuando la slice cambia por Object.is,
 * así que el re-render es exactamente tan selectivo como el selector.
 */
export function useStoreSlice<T>(handle: EditorHandle, selector: (state: VersoEditorState) => T): T {
  const subscribe = useCallback(
    (onStoreChange: () => void) => handle.subscribe<T>(() => onStoreChange(), selector),
    [handle, selector],
  );
  const getSnapshot = useCallback(() => selector(handle.getState()), [handle, selector]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const selectRootChildren = (s: VersoEditorState): string[] => s.doc.rootChildren;
export const selectInlineEditingId = (s: VersoEditorState): string | null => s.inlineEditingId;

/* ------------------------------------------------------------------ */
/* Suscripción por nodo — la base del render selectivo.                */
/* ------------------------------------------------------------------ */

export interface VersoNodeStore {
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): VersoNode | undefined;
}

/**
 * Par {subscribe,getSnapshot} sobre `handle.subscribeNode` — exactamente lo
 * que consume useSyncExternalStore. Exportado aparte para poder verificar la
 * selectividad (un setProps a un nodo notifica SOLO a ese nodo) en tests de
 * node puro, sin DOM.
 */
export function createNodeStore(handle: EditorHandle, nodeId: string): VersoNodeStore {
  return {
    subscribe: (onStoreChange) => handle.subscribeNode(nodeId, () => onStoreChange()),
    getSnapshot: () => handle.getDoc().nodes[nodeId],
  };
}

/** El nodo vivo; el bloque re-renderiza solo cuando SU nodo cambia de referencia. */
export function useVersoNode(handle: EditorHandle, nodeId: string): VersoNode | undefined {
  const store = useMemo(() => createNodeStore(handle, nodeId), [handle, nodeId]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
