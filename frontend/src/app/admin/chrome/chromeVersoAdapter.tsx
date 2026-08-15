"use client";

/**
 * Adaptador chrome→Verso (unificación del editor de chrome, checkpoint W52 — ver
 * documentation/verso/chrome-oracle.md §6).
 *
 * FIDELIDAD POR CONSTRUCCIÓN: los BlockDefinitions se derivan DEL PROPIO buildChromeEditorConfig
 * (el config legacy de /admin/chrome) — label/fields/defaultProps/render se reutilizan POR
 * REFERENCIA, jamás se copian a mano. Un render de Puck v0.20 es una función `(props) => JSX`, es
 * decir, un function component válido: los wrappers de binding (LogoEdit/NavEdit/…, con su caché
 * module-level de settings+menús, placeholders e hints de vacío) funcionan en Verso tal cual, sin
 * exportarlos ni duplicarlos.
 *
 * Únicas piezas propias:
 *  - ChromeRow: en Verso el slot llega como FUNCIÓN `(className?) => ReactNode` (contrato de
 *    VersoSlotRender), no como componente `<Items/>` de Puck — el render se sustituye con las
 *    MISMAS clases literales (ALIGN_CLASS/GAP_CLASS importados del mismo módulo que el legacy).
 *  - El root wrapper por part (C09 del oráculo) se reutiliza igualmente por referencia
 *    (config.root.render, un componente `({children}) => JSX`).
 *
 * SIN withSharedVersoFields A PROPÓSITO (oráculo C08): el contrato de chrome es una allowlist
 * CERRADA de props — hide/anim/look la violarían y el validador (fail-closed) tiraría la
 * composición entera.
 */

import type React from "react";
import type { ChromePart } from "@/lib/api";
import { ALIGN_CLASS, GAP_CLASS } from "@/components/chrome/ChromeRow";
import {
    createBlockRegistry,
    makeSlotResolver,
    type BlockDefinition,
    type BlockRegistry,
    type VersoField,
} from "@/lib/verso/registry";
import type { SlotResolver } from "@/lib/verso/types";
import type { VersoComponentMap } from "@/components/verso/render/context";
import { buildChromeEditorConfig } from "./chromeEditorConfig";

type SlotFn = (className?: string) => React.ReactNode;

/** En Verso el slot llega como función; si el nodo aún no tiene el slot, un slot vacío. */
const asSlot = (v: unknown): SlotFn => (typeof v === "function" ? (v as SlotFn) : () => null);

/**
 * ChromeRow en Verso: el ZONE div del slot ES el contenedor flex (mismas clases literales que el
 * render legacy de chromeEditorConfig y que el ChromeRow público) y los bloques dropeados quedan
 * como hijos flex directos — paridad C11 del oráculo.
 */
function ChromeRowVersoRender(props: Record<string, unknown>) {
    const { items, align, gap, wrap } = props;
    return asSlot(items)(
        `wjs-chrome-row flex items-center w-full min-h-12 ${ALIGN_CLASS[align as keyof typeof ALIGN_CLASS] ?? ALIGN_CLASS.start} ${GAP_CLASS[gap as keyof typeof GAP_CLASS] ?? GAP_CLASS.md}${wrap ? " flex-wrap" : ""}`,
    );
}

/** Forma mínima que este adaptador lee de una entrada de `config.components` de Puck. */
interface LegacyChromeComponentDef {
    label?: string;
    fields?: Record<string, unknown>;
    defaultProps?: Record<string, unknown>;
    render?: unknown;
}

/** Config legacy con la forma mínima que este adaptador consume. */
export interface LegacyChromeConfigShape {
    components: Record<string, LegacyChromeComponentDef>;
    root?: { render?: unknown };
}

/**
 * Adapta las entradas de `config.components` a BlockDefinitions. Exportado con el config como
 * PARÁMETRO para que el test anti-drift pueda pinear la reutilización POR REFERENCIA
 * (fields/render idénticos al config que él mismo construyó) — cada llamada a
 * buildChromeEditorConfig crea closures nuevas, así que la comparación exige compartir instancia.
 */
export function adaptChromeComponents(config: LegacyChromeConfigShape): BlockDefinition[] {
    return Object.entries(config.components).map(([type, def]) => ({
        type,
        label: def.label,
        // Estructuralmente compatibles: los campos de chrome son text/textarea/select/radio/slot
        // (subconjunto exacto de VersoField) — el test anti-drift los compara literal.
        fields: (def.fields ?? {}) as Record<string, VersoField>,
        defaultProps: { ...(def.defaultProps ?? {}) },
        render: type === "ChromeRow" ? ChromeRowVersoRender : def.render,
    }));
}

/**
 * Deriva los BlockDefinitions del config legacy del part. La exclusión de ChromeNav en
 * `announcement` viene GRATIS (el config legacy ya lo borra de components — oráculo §1).
 */
export function buildChromeBlockDefinitions(part: ChromePart): BlockDefinition[] {
    return adaptChromeComponents(buildChromeEditorConfig(part) as unknown as LegacyChromeConfigShape);
}

export interface ChromeVersoSetup {
    part: ChromePart;
    registry: BlockRegistry;
    componentMap: VersoComponentMap;
    isSlot: SlotResolver;
    /** Root wrapper por part (C09) — el MISMO componente del config legacy, por referencia. */
    RootWrapper: React.ComponentType<{ children?: React.ReactNode }>;
}

/** Construye registry + componentMap + resolutor de slots + root wrapper para un part. */
export function createChromeVersoSetup(part: ChromePart): ChromeVersoSetup {
    const config = buildChromeEditorConfig(part) as unknown as LegacyChromeConfigShape;
    const registry = createBlockRegistry();
    registry.register(adaptChromeComponents(config));
    const componentMap: VersoComponentMap = {};
    for (const def of registry.list()) {
        componentMap[def.type] = def.render as VersoComponentMap[string];
    }
    const RootWrapper = (config.root as { render?: unknown } | undefined)?.render as
        | React.ComponentType<{ children?: React.ReactNode }>
        | undefined;
    if (!RootWrapper) {
        // El config legacy SIEMPRE declara root.render (C09); fail-fast si eso cambiara.
        throw new Error(`chrome-verso: el config del part "${part}" no declara root.render`);
    }
    return { part, registry, componentMap, isSlot: makeSlotResolver(registry), RootWrapper };
}
