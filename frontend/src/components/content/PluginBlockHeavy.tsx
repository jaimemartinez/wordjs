"use client";
/**
 * The HEAVY half of PluginBlockIsland — el render de los bloques que el renderer del servidor no
 * posee: bloques de plugins de marketplace y Symbol. Se carga vía React.lazy desde el stub de la
 * isla, así que este chunk solo se pide cuando una página monta de verdad uno de esos bloques.
 *
 * RETIRADA DEL FORK (retirement-plan §16): antes montaba `<Render>` de @wordjs/puck con el config
 * runtime COMPLETO (`pageConfig` + merge de plugins), es decir arrastraba el grafo entero del editor
 * al camino público. Ahora:
 *  - los bloques de plugin se pintan llamando al `render` del propio bundle del plugin, tal cual lo
 *    entrega pluginBundleLoader (misma fuente que ya consumían el editor legacy vía
 *    useRuntimePuckConfig y Verso vía lib/verso/pluginBlocks) — sin config de editor de por medio;
 *  - Symbol delega en VersoSymbolRender, que pinta el subárbol con el MISMO switch compartido de
 *    ContentRenderer (RenderSubtree) y su cap de profundidad 1.
 * El wrapper de campos compartidos (hide/anim/look), que antes ponía withSharedBlockFields dentro
 * del config, lo pone aquí SharedBlockShell — el gemelo servidor de ese mismo wrapper, ya usado por
 * ContentRenderer para los bloques core. Una sola implementación, misma semántica.
 *
 * TIMING (sin cambios observables): los bundles se cargan en un efecto, jamás en SSR ni durante la
 * hidratación, igual que hacía useRuntimePuckConfig — hasta que llegan, el bloque no pinta nada
 * (equivalente al «Puck salta tipos desconocidos» de antes).
 */
import React from "react";
import SharedBlockShell from "./SharedBlockShell";
import { RenderSubtree } from "./ContentRenderer";
import { ixCtxFromSite, type IxMotionPolicy, type IxPreset } from "@/lib/verso/interactions";
import VersoSymbolRender from "@/components/verso/blocks/VersoSymbolBlock";
import { SYMBOL_BLOCK_TYPE } from "@/lib/symbols";
import { fetchActivePluginIds, loadPluginBlockConfigs } from "@/lib/pluginBundleLoader";
import { versoPluginComponents } from "@/lib/versoPluginRegistry";

type PluginBlockDef = {
    defaultProps?: Record<string, unknown>;
    render?: React.ComponentType<Record<string, unknown>>;
};

/**
 * Mapa de defs crudos {type → {fields, defaultProps, render}}, mergeado una sola vez por página:
 * memoizado a nivel de módulo para que N bloques de plugin en la misma página no disparen N cargas.
 * pluginBundleLoader ya memoiza éxito-solamente y NO memoiza fallos, así que un fallo total se
 * reintenta en el siguiente mount — aquí se replica esa política soltando la promesa fallida.
 */
let runtimeDefsPromise: Promise<Record<string, unknown>> | null = null;

function loadRuntimePluginDefs(): Promise<Record<string, unknown>> {
    if (runtimeDefsPromise) return runtimeDefsPromise;
    const attempt = (async () => {
        const ids = await fetchActivePluginIds();
        const merged: Record<string, unknown> = {};
        // Best-effort POR PLUGIN: uno caído se salta con warn y no tumba al resto ni a la página.
        // Misma precedencia que el Object.assign del camino legacy.
        await Promise.all(
            ids.map(async (id) => {
                try {
                    Object.assign(merged, await loadPluginBlockConfigs(id));
                } catch (e) {
                    console.warn(`[PluginBlock] Bloques no disponibles para '${id}':`, e);
                }
            }),
        );
        return merged;
    })();
    runtimeDefsPromise = attempt;
    attempt.catch(() => {
        if (runtimeDefsPromise === attempt) runtimeDefsPromise = null;
    });
    return attempt;
}

/** Bloques ESTÁTICOS de los plugins in-tree (dev): la misma salida generada que consume Verso. */
function staticDef(type: string): PluginBlockDef | null {
    const def = (versoPluginComponents as Record<string, unknown>)[type];
    return def && typeof def === "object" ? (def as PluginBlockDef) : null;
}

function usePluginBlockDef(type: string): PluginBlockDef | null {
    // Los estáticos están desde el primer render (determinista en SSR y cliente); los de marketplace
    // llegan post-hidratación y hacen upsert por clave — la misma precedencia que el legacy.
    const [runtime, setRuntime] = React.useState<PluginBlockDef | null>(null);
    React.useEffect(() => {
        let alive = true;
        loadRuntimePluginDefs()
            .then((defs) => {
                const def = defs[type];
                if (alive && def && typeof def === "object") setRuntime(def as PluginBlockDef);
            })
            .catch((e) => console.warn("[PluginBlock] Bloques runtime no disponibles:", e));
        return () => { alive = false; };
    }, [type]);
    return runtime ?? staticDef(type);
}

/**
 * Objeto `puck` de compatibilidad — el mismo contrato que ComponentConfig.render recibía en el
 * editor legacy, replicado aquí igual que en lib/verso/pluginBlocks (withPuckCompat). 0/31 bundles
 * del catálogo lo usan hoy, pero un plugin de terceros compilado contra el contrato viejo no debe
 * romperse. En el sitio público `isEditing` es SIEMPRE false.
 */
function puckCompat(props: Record<string, unknown>, ixPresets?: Record<string, IxPreset>) {
    return {
        isEditing: false,
        metadata: {},
        dragRef: null,
        renderDropZone: ({ zone, className }: { zone: string; className?: string }) => {
            const slot = props[zone];
            if (typeof slot === "function") return (slot as (cls?: string) => React.ReactNode)(className);
            // En el dato persistido un slot es un ARRAY de items: se pinta con el switch compartido.
            if (Array.isArray(slot)) return <div className={className}><RenderSubtree items={slot} ixPresets={ixPresets} /></div>;
            return null;
        },
    };
}

function PluginBlockRender({ type, props, ixPresets }: { type: string; props: Record<string, unknown>; ixPresets?: Record<string, IxPreset> }) {
    const def = usePluginBlockDef(type);
    const Render = def?.render;
    // Tipo desconocido (plugin inactivo, bundle sin ese bloque, o aún cargando): no se pinta nada —
    // exactamente lo que hacía <Render> del fork con un componente no registrado.
    if (typeof Render !== "function") return null;
    return <Render {...(def?.defaultProps || {})} {...props} puck={puckCompat(props, ixPresets)} />;
}

/**
 * `ixPresets` (catálogo del SITIO ya normalizado en el servidor) llega como prop porque este
 * componente es de CLIENTE y no puede leer ajustes. Lo que NO llega es la página compilada: lleva
 * un `Map` y no cruza la frontera de serialización — la clase sale del hash desnudo, que coincide
 * con el de la página salvo colisión de hash entre dos cuerpos distintos (ver SharedBlockShell).
 */
export default function PluginBlockHeavy({ item, ixPresets, motion }: { item: any; ixPresets?: Record<string, IxPreset>; motion?: IxMotionPolicy }) {
    const type = typeof item?.type === "string" ? item.type : "";
    const props = (item?.props || {}) as Record<string, unknown>;
    const inner = type === SYMBOL_BLOCK_TYPE
        ? <VersoSymbolRender symbolId={props.symbolId} resolvedSymbolItems={props.resolvedSymbolItems} />
        : <PluginBlockRender type={type} props={props} ixPresets={ixPresets} />;
    return (
        <SharedBlockShell hide={props.hide as any} anim={props.anim as any} look={props.look as any} ix={props.ix} ixCtx={{ ...(ixPresets ? ixCtxFromSite(ixPresets) : {}), ...(motion ? { motion } : {}) }}>
            {inner}
        </SharedBlockShell>
    );
}
