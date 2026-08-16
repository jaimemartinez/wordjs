"use client";
/**
 * Verso — suscripción React a la versión del BlockRegistry.
 *
 * El registry es IDENTIDAD-ESTABLE por contrato (registry.ts: se crea una vez y `register()` muta el
 * Map interno, jamás recrea el objeto). Eso significa que un `useMemo(..., [registry])` NO se recalcula
 * cuando llegan bloques nuevos — exactamente lo que pasa en F4, donde los bloques de plugin de
 * marketplace se registran POST-hidratación (pluginBlocks.ts). Este hook expone el contador
 * `version()` (un bump por llamada a register()) vía useSyncExternalStore, para que los derivados del
 * registry (componentMap del editor, catálogos de la paleta/⌘K) declaren la dependencia real:
 * `useMemo(..., [registry, version])`.
 *
 * getSnapshot devuelve un NÚMERO (primitivo): estable entre renders sin bump, así que nunca provoca el
 * bucle infinito que tendría un snapshot con identidad fresca (p.ej. registry.list()).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { BlockRegistry } from "./registry";

export function useRegistryVersion(registry: BlockRegistry): number {
  const subscribe = useCallback(
    (onStoreChange: () => void) => registry.subscribe(onStoreChange),
    [registry],
  );
  const getSnapshot = useCallback(() => registry.version(), [registry]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
