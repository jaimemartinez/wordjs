"use client";
/**
 * Verso — camino runtime de los bloques de plugin de marketplace (F4).
 *
 * Los 31 plugins del catálogo funcionan en Verso SIN recompilar sus bundles publicados: este módulo
 * REUTILIZA pluginBundleLoader.ts entero (fetch + Blob + import de blob:, memoización éxito-solamente,
 * 404 = «no trae bloques», evicción identity-guarded — ~10 fixes de carreras documentados allí, cada
 * uno un incidente real; NO se reimplementa nada de eso aquí) y adapta el mapa crudo que devuelve
 * (`Record<nombreDeBloque, {label?, category?, fields, defaultProps, render}>` — la MISMA forma para
 * las dos variantes legacy, porque loadPluginBlockConfigs ya compone `render` en la single-block) a
 * `BlockDefinition`, registrándolo en el BlockRegistry del editor.
 *
 * Contratos que este módulo cumple:
 *  - IDENTIDAD ESTABLE (anti-remount): el registry NUNCA se recrea — register() + bump de version.
 *    Además, re-adaptar el MISMO def crudo devuelve el MISMO BlockDefinition (WeakMap), así que una
 *    pasada repetida (StrictMode, remount del editor, reload de plugins) no re-registra nada: cero
 *    bumps de versión, cero cambios de identidad de render, cero remounts de bloques ya pintados.
 *  - SEAM DE CAMPOS COMPARTIDOS: cada def pasa por withSharedVersoFields — hide/anim/look con los
 *    mismos defaults y clamps que reciben en el editor legacy vía useRuntimePuckConfig →
 *    withSharedBlockFields. El wrapper visual lo pone VersoBlock (SharedBlockShell), como al core.
 *  - COMPAT `puck`: el render del plugin recibe además un objeto `puck` compatible con el contrato
 *    de ComponentConfig.render del editor legacy — {isEditing, metadata, renderDropZone, dragRef} —
 *    con renderDropZone mapeado al slot del motor (la función `(className?)=>ReactNode` que VersoBlock
 *    inyecta bajo la clave del slot). 0/31 bundles lo usan hoy (legacy-surface.md §6), pero un plugin
 *    de terceros compilado contra el contrato viejo no debe romperse.
 *  - HYDRATION-SAFETY: useVersoPluginBlocks carga en useEffect (jamás SSR ni durante la hidratación),
 *    el mismo timing que useRuntimePuckConfig; hasta que el registro llega, VersoBlock pinta el
 *    placeholder fail-soft `data-verso-missing` (equivalente al «Puck salta tipos desconocidos»).
 *  - DEGRADACIÓN SUAVE: un plugin caído (5xx/red/bundle inevaluable) se salta con console.warn y no
 *    rompe ni el editor ni al resto de plugins; el fallo de la LISTA de activos rechaza en el loader
 *    (por diseño, para no envenenar cachés) y aquí lo captura el hook — sin retry propio, porque el
 *    loader no memoiza fallos y el siguiente mount reintenta solo.
 *  - BLOQUES ESTÁTICOS (dev, 8 plugins in-tree): registerStaticPluginBlocks consume la MISMA salida
 *    generada (lib/puckPluginRegistry.ts, de scripts/generate-puck-plugin-registry.js — fichero que
 *    JAMÁS se commitea) que ya consume el editor legacy vía puckConfig.tsx: una sola fuente, dos
 *    editores, sin tocar el generador ni el camino legacy. Se registra síncrono al crear el registry
 *    (mismo momento que el merge estático del legacy: presente desde el primer render, determinista
 *    en SSR y cliente); el camino runtime hace después upsert por clave — la misma precedencia que el
 *    spread `{...base, ...runtime}` del legacy.
 *
 * CSS de bloque: el canvas de Verso es un iframe con documento propio, así que el <link> que
 * pluginBundleLoader inyecta en el documento top-level no le llega — el hook re-inyecta por
 * documento de frame vía injectBlockCssInto (el seam aditivo del loader), solo para los plugins que
 * realmente entregaron bloques.
 */
import React, { useEffect, useState } from "react";
import {
  fetchActivePluginIds,
  loadPluginBlockConfigs,
  injectBlockCssInto,
} from "@/lib/pluginBundleLoader";
import { puckPluginComponents } from "@/lib/puckPluginRegistry";
import {
  adaptLegacySingle,
  type BlockDefinition,
  type BlockRegistry,
  type LegacySingleBlockDef,
} from "./registry";
import { withSharedVersoFields } from "./sharedFields";

/* ------------------------------------------------------------------ */
/* Compat `puck` — el objeto que ComponentConfig.render recibía en el  */
/* editor legacy. Verificado que el adaptador de registry NO lo compone */
/* (adaptLegacySingle pasa el render tal cual), así que se añade aquí.  */
/* ------------------------------------------------------------------ */

type LegacyRenderComponent = React.ComponentType<Record<string, unknown>>;

interface PuckCompatObject {
  isEditing: boolean;
  metadata: Record<string, unknown>;
  dragRef: null;
  renderDropZone: (props: { zone: string; className?: string }) => React.ReactNode;
}

/**
 * Envuelve el render legacy UNA vez (en el punto de adaptación, nunca por render) para inyectar la
 * prop `puck`. renderDropZone({zone}) resuelve al slot del motor: VersoBlock ya inyecta, por cada
 * clave de slot del nodo, una función `(className?) => ReactNode` bajo esa misma clave — así que un
 * bloque contenedor legacy que pidiera `puck.renderDropZone({zone:"children"})` pinta la MISMA zona
 * que uno Verso que llame `props.children(className)`.
 */
function withPuckCompat(render: LegacyRenderComponent): LegacyRenderComponent {
  function VersoPluginBlock(props: Record<string, unknown>) {
    const puck: PuckCompatObject = {
      isEditing: props.isEditing === true,
      metadata: {},
      dragRef: null,
      renderDropZone: ({ zone, className }) => {
        const slot = props[zone];
        return typeof slot === "function"
          ? (slot as (cls?: string) => React.ReactNode)(className)
          : null;
      },
    };
    const Legacy = render;
    return <Legacy {...props} puck={puck} />;
  }
  VersoPluginBlock.displayName = `VersoPluginBlock(${render.displayName || render.name || "Anonymous"})`;
  return VersoPluginBlock;
}

/* ------------------------------------------------------------------ */
/* Adaptación def crudo → BlockDefinition (memoizada por identidad).    */
/* ------------------------------------------------------------------ */

// Def crudo → BlockDefinition adaptado. Clave por IDENTIDAD del objeto crudo: los defs vienen de
// promesas memoizadas (blockConfigCache) o de un módulo estático, así que una pasada repetida ve los
// MISMOS objetos y recupera el MISMO BlockDefinition — la condición para que registerPluginBlocks
// pueda saltarse el re-registro (cero bumps, cero remounts).
const adaptedByRawDef = new WeakMap<object, BlockDefinition>();

/**
 * Adapta UNA entrada del mapa crudo. `null` si la entrada no cumple el contrato mínimo (render
 * función) — se degrada con warn, jamás se lanza: el input es código de terceros.
 */
export function adaptPluginBlock(type: string, raw: unknown): BlockDefinition | null {
  if (!raw || typeof raw !== "object") {
    console.warn(`[VersoPluginBlocks] Bloque '${type}' descartado: definición no es un objeto`);
    return null;
  }
  const rawDef = raw as Record<string, unknown>;
  if (typeof rawDef.render !== "function") {
    console.warn(`[VersoPluginBlocks] Bloque '${type}' descartado: sin render`);
    return null;
  }
  const hit = adaptedByRawDef.get(rawDef);
  if (hit && hit.type === type) return hit;

  const legacy: LegacySingleBlockDef = {
    label: typeof rawDef.label === "string" ? rawDef.label : undefined,
    category: typeof rawDef.category === "string" ? rawDef.category : undefined,
    fields: (rawDef.fields && typeof rawDef.fields === "object"
      ? rawDef.fields
      : {}) as Record<string, unknown>,
    defaultProps: (rawDef.defaultProps && typeof rawDef.defaultProps === "object"
      ? rawDef.defaultProps
      : {}) as Record<string, unknown>,
  };
  const def = withSharedVersoFields(
    adaptLegacySingle(legacy, withPuckCompat(rawDef.render as LegacyRenderComponent), type),
  );
  adaptedByRawDef.set(rawDef, def);
  return def;
}

/**
 * Adapta y registra un mapa crudo de bloques (la forma que devuelve loadPluginBlockConfigs, y también
 * la del registry estático generado). UNA llamada a register() por pasada (un solo bump de versión);
 * las entradas cuyo BlockDefinition YA está registrado con la misma identidad se saltan — una pasada
 * idéntica repetida no bumpea nada. Devuelve los `type` registrados en esta pasada.
 */
export function registerPluginBlocks(
  registry: BlockRegistry,
  blocks: Record<string, unknown>,
): string[] {
  const defs: BlockDefinition[] = [];
  for (const [type, raw] of Object.entries(blocks)) {
    const def = adaptPluginBlock(type, raw);
    if (!def) continue;
    if (registry.get(type) === def) continue; // idéntico: sin re-registro, sin bump
    defs.push(def);
  }
  if (defs.length) registry.register(defs);
  return defs.map((d) => d.type);
}

/**
 * Bloques ESTÁTICOS de los plugins in-tree (dev): la salida de generate-puck-plugin-registry.js, la
 * misma que el legacy mergea en puckConfig. Llamar SÍNCRONO al crear el registry (junto a
 * registerCoreBlocks) — así están desde el primer render, como en el legacy. `components` inyectable
 * solo para tests.
 */
export function registerStaticPluginBlocks(
  registry: BlockRegistry,
  components: Record<string, unknown> = puckPluginComponents,
): string[] {
  return registerPluginBlocks(registry, components);
}

/* ------------------------------------------------------------------ */
/* Carga runtime (marketplace) + registro.                              */
/* ------------------------------------------------------------------ */

export interface VersoPluginBlocksResult {
  /** Plugins activos que entregaron al menos un bloque (candidatos a CSS de bloque). */
  pluginIdsWithBlocks: string[];
  /** Tipos registrados en ESTA pasada (vacío si todo estaba ya registrado). */
  registeredTypes: string[];
}

/**
 * fetch de activos → bundles `component` por plugin (loader real, con todas sus cachés) → adaptación
 * → UN register(). Best-effort POR PLUGIN (un plugin caído se salta con warn); RECHAZA solo si la
 * lista de activos no se pudo obtener — la misma semántica que el legacy (useRuntimePuckConfig), donde
 * esa rechaza para no envenenar la caché y el caller la captura.
 */
export async function loadVersoPluginBlocks(
  registry: BlockRegistry,
): Promise<VersoPluginBlocksResult> {
  const ids = await fetchActivePluginIds();
  const perPlugin = await Promise.all(
    ids.map(async (id) => {
      try {
        return { id, blocks: await loadPluginBlockConfigs(id) };
      } catch (e) {
        console.warn(`[VersoPluginBlocks] Bloques no disponibles para '${id}':`, e);
        return { id, blocks: {} as Record<string, unknown> };
      }
    }),
  );
  const merged: Record<string, unknown> = {};
  const pluginIdsWithBlocks: string[] = [];
  for (const { id, blocks } of perPlugin) {
    const keys = Object.keys(blocks);
    if (keys.length === 0) continue;
    pluginIdsWithBlocks.push(id);
    Object.assign(merged, blocks); // misma precedencia que el Object.assign del legacy
  }
  const registeredTypes = registerPluginBlocks(registry, merged);
  return { pluginIdsWithBlocks, registeredTypes };
}

/**
 * Hook de cableado en el editor (VersoEditor): carga POST-hidratación (useEffect tras montar, jamás
 * SSR) y registra en el registry vivo — los consumidores reaccionan vía useRegistryVersion. Un fallo
 * total (lista de activos inaccesible) degrada en silencio con warn: el editor sigue funcionando y el
 * siguiente mount reintenta (el loader no memoiza fallos).
 *
 * `frameDoc`: documento del iframe del canvas (onFrameReady) — al existir, se le inyecta el CSS de
 * bloque de cada plugin que entregó bloques. Deduplicado por documento; un frame nuevo re-inyecta.
 */
export function useVersoPluginBlocks(
  registry: BlockRegistry,
  frameDoc?: Document | null,
): void {
  const [cssPluginIds, setCssPluginIds] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    loadVersoPluginBlocks(registry)
      .then(({ pluginIdsWithBlocks }) => {
        if (alive && pluginIdsWithBlocks.length) setCssPluginIds(pluginIdsWithBlocks);
      })
      .catch((e) => console.warn("[VersoPluginBlocks] Bloques runtime no disponibles:", e));
    return () => {
      alive = false;
    };
  }, [registry]);

  useEffect(() => {
    if (!frameDoc) return;
    for (const id of cssPluginIds) injectBlockCssInto(frameDoc, id);
  }, [frameDoc, cssPluginIds]);
}
