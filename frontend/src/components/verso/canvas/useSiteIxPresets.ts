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
 *     solos. Un temporizador por editor abierto no compra nada; lo que sí se hace es releer UNA vez
 *     cuando la pestaña vuelve a primer plano (el autor suele crear el preajuste en Ajustes, en otra
 *     pestaña, y volver) y cuando el propio editor guarda uno («Guardar como preajuste» del dock,
 *     `setSiteIxCtx`). Sin eso, el desplegable mentía hasta recargar el editor.
 */
import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { ixCtxFromSetting, SYS_IX_PRESETS, type IxCompileCtx } from "@/lib/verso/interactions";

/** Solo los del sistema: lo que se usa mientras la lectura viaja, y si nunca llega. */
export const SYS_ONLY_IX_CTX: IxCompileCtx = { presets: SYS_IX_PRESETS };

let pending: Promise<IxCompileCtx> | null = null;
let resolved: IxCompileCtx | null = null;
/** Montajes vivos del hook: un catálogo nuevo les llega a todos (panel, dock y motor del canvas). */
const listeners = new Set<(ctx: IxCompileCtx) => void>();

/** Solo para tests: olvida la caché de módulo. */
export function resetSiteIxPresetsCache(): void {
  pending = null;
  resolved = null;
}

/** Publica un catálogo ya conocido (p. ej. el que acaba de guardar el editor) a todos los montajes. */
export function setSiteIxCtx(ctx: IxCompileCtx): void {
  resolved = ctx;
  pending = null;
  for (const l of listeners) l(ctx);
}

/** Relee el ajuste y lo publica. Fail-open como la primera lectura: un fallo deja lo que había. */
let refreshing: Promise<IxCompileCtx> | null = null;
export function refreshSiteIxPresets(): Promise<IxCompileCtx> {
  // Varias llamadas a la vez (un montaje por consumidor oye el mismo visibilitychange) comparten UNA.
  if (refreshing) return refreshing;
  resolved = null;
  pending = null;
  refreshing = loadSiteIxCtx()
    .then((ctx) => {
      for (const l of listeners) l(ctx);
      return ctx;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
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
    const apply = (next: IxCompileCtx) => {
      if (!cancelled) setCtx((prev) => (prev === next ? prev : next));
    };
    listeners.add(apply);
    void loadSiteIxCtx().then(apply);
    // Volver a la pestaña relee; los demás montajes que oyen el mismo evento comparten la lectura.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshSiteIxPresets();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      listeners.delete(apply);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return ctx;
}
