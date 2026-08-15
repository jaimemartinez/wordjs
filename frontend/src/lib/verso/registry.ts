/**
 * Verso — registro de bloques versionado.
 *
 * Contrato de campos (`VersoField`): reescritura con compatibilidad de INTERFAZ (no de expresión) de
 * la union `Field`/`FieldProps` de `frontend/packages/puck/types/Fields.ts` — el fork vendorizado se usa
 * SOLO como referencia de forma, nunca se importa. Los 31 plugins de marketplace + los bloques core ya
 * declaran sus `fields` contra esa forma (ver documentation/verso/f0-audit-core.md, contrato duro L29);
 * cualquier `fields` legacy debe ser asignable estructuralmente a `Record<string, VersoField>` sin más
 * que un adaptador de shape (ver `adaptLegacySingle`/`adaptLegacyMulti` más abajo).
 *
 * `makeSlotResolver` produce el `SlotResolver` (types.ts) que consume `toNormalized` — mantiene
 * `normalize.ts` sin importar este módulo, tal como exige su propio contrato ("Mantiene normalize.ts
 * independiente del registry completo").
 *
 * Contrato de identidad (`createBlockRegistry`): "el objeto de config identidad-estable: cualquier editor
 * nuevo que re-genere el objeto de configuración de bloques en cada render... fuerza un remount completo
 * del árbol de edición — contrato de rendimiento no negociable" (f0-audit-core.md L194). El objeto
 * `BlockRegistry` devuelto por `createBlockRegistry()` se crea UNA vez y jamás se reemplaza: toda
 * mutación (`register`) ocurre sobre el `Map` interno, nunca recreando el objeto raíz.
 */

import type { SlotResolver } from "./types";

/* ------------------------------------------------------------------ */
/* Campos de bloque.                                                   */
/* ------------------------------------------------------------------ */

/** Propiedades comunes a los 10 tipos de campo (equivalente a `BaseField` de Puck). */
export interface VersoFieldBase {
  label?: string;
  /**
   * Icono junto al label. Tipado laxo a propósito: es un nodo de React, y este módulo no importa
   * React (el registro es agnóstico del framework de UI que finalmente pinte el panel de props).
   */
  labelIcon?: unknown;
  /** Metadata libre que una implementación de campo (p.ej. `custom`) puede leer en tiempo de render. */
  metadata?: Record<string, unknown>;
  /** `false` oculta el campo del panel de propiedades sin retirarlo del contrato de datos del bloque. */
  visible?: boolean;
}

export interface VersoFieldOption {
  label: string;
  value: string | number | boolean | null | undefined | object;
}

export interface TextVersoField extends VersoFieldBase {
  type: "text";
  placeholder?: string;
  /** Habilita edición directa sobre el propio nodo del canvas en vez de (solo) el panel lateral. */
  contentEditable?: boolean;
}

export interface NumberVersoField extends VersoFieldBase {
  type: "number";
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface TextareaVersoField extends VersoFieldBase {
  type: "textarea";
  placeholder?: string;
  contentEditable?: boolean;
}

export interface SelectVersoField extends VersoFieldBase {
  type: "select";
  options: readonly VersoFieldOption[];
}

export interface RadioVersoField extends VersoFieldBase {
  type: "radio";
  options: readonly VersoFieldOption[];
}

/**
 * Lista editable de sub-objetos con forma fija (NO hijos de árbol — sus entradas no son `VersoItem`,
 * son props planas). Un `array` cuyo valor en runtime *parezca* un array de bloques (`isVersoItemArray`)
 * sigue sin ser slot: es la distinción que separa este tipo de `SlotVersoField` — ver `makeSlotResolver`.
 */
export interface ArrayVersoField extends VersoFieldBase {
  type: "array";
  arrayFields: Record<string, VersoField>;
  defaultItemProps?: Record<string, unknown>;
  getItemSummary?: (item: Record<string, unknown>, index?: number) => string;
  min?: number;
  max?: number;
}

/** Sub-objeto con forma fija editado inline como grupo de campos (sin repetición, a diferencia de `array`). */
export interface ObjectVersoField extends VersoFieldBase {
  type: "object";
  objectFields: Record<string, VersoField>;
}

/**
 * Selector con datos remotos (fetch-on-demand). Modela solo la forma vigente (`fetchList`); la variante
 * `adaptor` de Puck está marcada DEPRECATED en la fuente y 0/31 plugins la usan (documentation/verso/
 * legacy-surface.md §6) — no se modela aquí a propósito.
 */
export interface ExternalVersoField extends VersoFieldBase {
  type: "external";
  placeholder?: string;
  fetchList: (params: { query: string; filters: Record<string, unknown> }) => Promise<unknown[] | null>;
  mapProp?: (value: unknown) => unknown;
  getItemSummary?: (item: unknown, index?: number) => string;
  showSearch?: boolean;
  initialQuery?: string;
  filterFields?: Record<string, VersoField>;
  initialFilters?: Record<string, unknown>;
}

/** Editor de campo hecho a medida por el propio bloque (p.ej. el selector de galería de card-gallery). */
export interface CustomVersoField extends VersoFieldBase {
  type: "custom";
  render: (props: {
    field: CustomVersoField;
    name: string;
    id: string;
    value: unknown;
    onChange: (value: unknown) => void;
    readOnly?: boolean;
  }) => unknown;
  contentEditable?: boolean;
}

/**
 * Hijos de árbol reales: el valor en `props[key]` es un array de `VersoItem` (nodos anidados), nunca
 * datos planos. Es el ÚNICO tipo que `makeSlotResolver` traduce a `true`.
 */
export interface SlotVersoField extends VersoFieldBase {
  type: "slot";
  allow?: string[];
  disallow?: string[];
}

export type VersoField =
  | TextVersoField
  | NumberVersoField
  | TextareaVersoField
  | SelectVersoField
  | RadioVersoField
  | ArrayVersoField
  | ObjectVersoField
  | ExternalVersoField
  | CustomVersoField
  | SlotVersoField;

/* ------------------------------------------------------------------ */
/* Definición de bloque.                                               */
/* ------------------------------------------------------------------ */

/**
 * Referencia al componente de render del bloque. Deliberadamente `unknown`: este módulo no importa
 * React (evita acoplar el registro al framework de UI); quien consume una `BlockDefinition` real para
 * pintarla (F3/F4) la re-tipa como `React.ComponentType<Props>` en su propio módulo.
 */
export type VersoBlockRenderer = unknown;

export interface BlockDefinition {
  /** Discriminante único del bloque — clave de registro, y el `item.type` que viaja en `_puck_data`. */
  type: string;
  label?: string;
  category?: string;
  fields: Record<string, VersoField>;
  defaultProps: Record<string, unknown>;
  /**
   * Declara qué prop es el destino de edición inline directa sobre el canvas (sustituye el botón "Edit"
   * hardcodeado a Text/Heading del fork — f0-audit-core.md Divergencia 2). `rich` = HTML enriquecido
   * (Tiptap); `plain` = texto sin formato.
   */
  inline?: { prop: string; schema: "rich" | "plain" };
  render: VersoBlockRenderer;
}

/* ------------------------------------------------------------------ */
/* Registro: identidad estable + versión + suscripción.                */
/* ------------------------------------------------------------------ */

export interface BlockRegistry {
  /** Alta o reemplazo (upsert por `type`) de una o más definiciones. Incrementa `version()` en 1 por LLAMADA. */
  register(defs: BlockDefinition | BlockDefinition[]): void;
  get(type: string): BlockDefinition | undefined;
  /** Snapshot en orden de alta/última actualización. El array es nuevo en cada llamada; el registro no. */
  list(): BlockDefinition[];
  version(): number;
  /** Notifica en cada bump de `version()`. Devuelve la función de desuscripción. */
  subscribe(listener: () => void): () => void;
}

/**
 * El objeto devuelto es la identidad estable del registro: se construye una única vez y NUNCA se
 * recrea — `register()` muta el `Map` interno, no reemplaza `registry`. Un consumidor que memoice
 * sobre esta referencia (p.ej. el config de un editor) no sufre el remount que motivó este contrato.
 */
export function createBlockRegistry(): BlockRegistry {
  const defs = new Map<string, BlockDefinition>();
  const listeners = new Set<() => void>();
  let ver = 0;

  const registry: BlockRegistry = {
    register(input) {
      const items = Array.isArray(input) ? input : [input];
      for (const def of items) defs.set(def.type, def);
      ver += 1;
      for (const listener of listeners) listener();
    },
    get(type) {
      return defs.get(type);
    },
    list() {
      return Array.from(defs.values());
    },
    version() {
      return ver;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return registry;
}

/* ------------------------------------------------------------------ */
/* Adaptadores de compatibilidad — shape legacy de los 31 plugins.     */
/* Confirmado bloques HOJA puros, sin renderDropZone/usePuck/useGetPuck */
/* (documentation/verso/legacy-surface.md §6, 0/31 en los 4 patrones). */
/* ------------------------------------------------------------------ */

/**
 * Forma legacy de un bloque single-block: `puckComponentDef` exportado por el plugin, SIN `render`
 * (el generador lo compone aparte — generate-puck-plugin-registry.js:169). Ejemplo real:
 * marketplace/plugins/testimonials/client/puck/TestimonialsPuck.tsx.
 */
export interface LegacySingleBlockDef {
  label?: string;
  category?: string;
  fields: Record<string, unknown>;
  defaultProps: Record<string, unknown>;
}

/**
 * Convierte el shape `{category, fields, defaultProps}` + `render` aparte + `type` explícito (el
 * generador usa el PascalCase del plugin) a `BlockDefinition`. `fields` se acepta como
 * `Record<string, unknown>` porque el origen (JS suelto o `@ts-nocheck`) no tipa contra `VersoField`
 * — la compatibilidad es de INTERFAZ verificada en tests con fixtures reales, no forzada por el compilador.
 */
export function adaptLegacySingle(
  def: LegacySingleBlockDef,
  render: VersoBlockRenderer,
  type: string,
): BlockDefinition {
  return {
    type,
    label: def.label,
    category: def.category,
    fields: def.fields as Record<string, VersoField>,
    defaultProps: def.defaultProps,
    render,
  };
}

/**
 * Forma legacy de un bloque dentro de un export multi-block: `export const puckComponents = {...}`
 * (detectado por regex en el generador, f0-audit-core.md L180) — cada entrada YA trae `render` compuesto
 * por el propio plugin. Ejemplo real: marketplace/plugins/online-store/client/puck/OnlineStorePuck.tsx
 * (`{ OnlineStore: {...def, render}, StoreOrders: {...def, render} }`).
 */
export interface LegacyMultiBlockDef extends LegacySingleBlockDef {
  render: VersoBlockRenderer;
}

/**
 * Expande el mapa `puckComponents` a un `BlockDefinition` por entrada, usando la CLAVE del mapa como
 * `type` — preserva el nombre v1 exacto que ya referencian páginas guardadas (p.ej. "OnlineStore").
 */
export function adaptLegacyMulti(puckComponents: Record<string, LegacyMultiBlockDef>): BlockDefinition[] {
  return Object.entries(puckComponents).map(([type, def]) => adaptLegacySingle(def, def.render, type));
}

/* ------------------------------------------------------------------ */
/* Puente registry → normalize: el resolutor de slots real.            */
/* ------------------------------------------------------------------ */

/**
 * `SlotResolver` (types.ts) respaldado por un `BlockRegistry`. Contrato exacto:
 * - Tipo NO registrado → `undefined` (normalize.ts cae a detección estructural: `isVersoItemArray`).
 * - Campo NO declarado en `fields` de un tipo SÍ registrado → también `undefined`, deliberadamente: no
 *   confundir "sin opinión" (p.ej. `hide`/`anim`/`look`/`css`, inyectados por `withSharedBlockFields`
 *   POR FUERA del `fields` que el propio bloque declara — f0-audit-core.md L78) con "declarado no-slot".
 * - Campo declarado con `type:"slot"` → `true` (incluso con valor `[]`: slot vacío SIGUE siendo slot).
 * - Campo declarado con cualquier OTRO tipo (incluido `array`, cuyo valor puede tener forma de hijos de
 *   árbol) → `false`, siempre — nunca se re-clasifica por la forma del valor en runtime.
 */
export function makeSlotResolver(registry: BlockRegistry): SlotResolver {
  return (type: string, propKey: string): boolean | undefined => {
    const def = registry.get(type);
    if (!def) return undefined;
    const field = def.fields[propKey];
    if (!field) return undefined;
    return field.type === "slot";
  };
}
