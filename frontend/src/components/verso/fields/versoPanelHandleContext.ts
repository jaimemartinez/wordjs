"use client";
/**
 * Verso — contexto que entrega el `EditorHandle` a los CONTROLES DE CAMPO del panel de propiedades.
 *
 * El contrato de un campo `custom` (registry.ts) entrega solo `{field, name, id, value, onChange}`:
 * un control que necesita leer OTRAS props del bloque seleccionado (p.ej. el editor de elementos de
 * menú, que necesita la referencia source/location/menuId para saber QUÉ menú del store nav_menu
 * editar) no puede obtenerlas por props sin ensanchar ese contrato para los 38 bloques.
 *
 * En su lugar, VersoEditor monta este provider alrededor de PropertiesPanel con el handle del
 * editor; el control lee la selección y las props del nodo vivo vía `useStoreSlice`, con la misma
 * reactividad selectiva del resto del editor. Fuera del editor Verso (p.ej. el registro espejo de
 * versoConfig, que hoy solo existe para el gate anti-drift) el contexto es null y el control
 * degrada a un aviso, jamás revienta.
 */
import { createContext, useContext } from "react";
import type { EditorHandle } from "@/lib/verso/store";

export const VersoPanelHandleContext = createContext<EditorHandle | null>(null);

/** El handle del editor si el control vive dentro del panel de Verso; null fuera de él. */
export function useVersoPanelHandle(): EditorHandle | null {
    return useContext(VersoPanelHandleContext);
}
