"use client";
/**
 * Verso — presets de interacción DEL SITIO en el editor (F9-E, lado cliente).
 *
 * El sitio público lee `wjs_ix_presets` en el servidor y lo pasa por props (ContentRenderer). El
 * editor no tiene ese camino: se monta en /admin y su canvas no pasa por el renderer público. Este
 * hook lo resuelve con UNA lectura del endpoint público de ajustes, compartida por todos sus
 * consumidores (el panel de propiedades y el motor del canvas piden lo mismo).
 *
 * TRES DECISIONES, y por qué:
 *
 *  1. **Una promesa por proceso, no una por componente.** Sin la caché de módulo, montar el panel y
 *     el motor del canvas dispararía dos GET /settings idénticos, y cada remontaje del panel otro
 *     más. La promesa se comparte; el resultado, también.
 *  2. **Fail-open.** Si la petición falla (backend caído, sesión rara) el editor se queda con los
 *     presets del SISTEMA. Un preajuste de sitio que no se puede listar es una opción que falta en
 *     un desplegable; un editor que no arranca por eso sería un fallo de verdad.
 *  3. **Sin polling ni reintentos.** Los presets cambian cuando un admin los edita en Ajustes, no
 *     solos. Recargar el editor los trae; un temporizador por editor abierto no compra nada.
 */
import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { ixCtxFromSetting, SYS_IX_PRESETS, type IxCompileCtx } from "@/lib/verso/interactions";

/** Solo los del sistema: lo que se usa mientras la lectura viaja, y si nunca llega. */
export const SYS_ONLY_IX_CTX: IxCompileCtx = { presets: SYS_IX_PRESETS };

let pending: Promise<IxCompileCtx> | null = null;
let resolved: IxCompileCtx | null = null;

/** Solo para tests: olvida la caché de módulo. */
export function resetSiteIxPresetsCache(): void {
  pending = null;
  resolved = null;
}

function loadSiteIxCtx(): Promise<IxCompileCtx> {
  if (resolved) return Promise.resolve(resolved);
  if (!pending) {
    pending = settingsApi
      .get()
      .then((settings) => {
        // El ajuste es dato hostil incluso viniendo de nuestro propio backend: `ixCtxFromSetting`
        // lo pasa entero por `normalizeIxPreset` y devuelve `{}` ante cualquier cosa rara.
        const ctx = ixCtxFromSetting((settings as Record<string, unknown> | null)?.wjs_ix_presets);
        resolved = ctx;
        return ctx;
      })
      .catch(() => {
        // No se cachea el fallo: la siguiente montura vuelve a intentarlo una vez.
        pending = null;
        return SYS_ONLY_IX_CTX;
      });
  }
  return pending;
}

/**
 * Contexto de compilación con los presets del sistema + los del sitio. Empieza por los del sistema
 * y se amplía cuando llega la lectura — nunca hay un render sin catálogo.
 */
export function useSiteIxPresets(): IxCompileCtx {
  const [ctx, setCtx] = useState<IxCompileCtx>(() => resolved ?? SYS_ONLY_IX_CTX);

  useEffect(() => {
    let cancelled = false;
    void loadSiteIxCtx().then((next) => {
      if (!cancelled) setCtx((prev) => (prev === next ? prev : next));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return ctx;
}
