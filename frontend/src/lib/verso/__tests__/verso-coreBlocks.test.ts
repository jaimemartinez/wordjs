/**
 * GATE F3 — los 35 bloques core como tabla de datos + seam de shared fields.
 *
 * ANTI-DRIFT: la fuente de verdad de la comparación es versoConfig.tsx IMPORTADO (no una copia):
 * defaultProps se comparan por deep-equal PROGRAMÁTICO campo a campo, y los `fields` por igualdad
 * estructural con las funciones sustituidas por un marcador (los `render` de campos custom no son
 * comparables por valor; todo lo demás — type, label, options, placeholders, min/max, arrayFields —
 * se compara literal). Cualquier drift en nombres de prop, opciones o defaults rompe aquí antes de
 * romper páginas guardadas o el theming.
 *
 * También cubre: la lista LITERAL de los 35 `item.type` del switch público (contrato de
 * serialización), la resolución de slots vía makeSlotResolver (igual que el editor actual),
 * los clamps de seguridad de anim (100–3000ms), el opt-out del seam y la asimetría de los campos
 * root post/page.
 */
import { describe, expect, it } from "vitest";
import {
  CORE_BLOCK_TYPES,
  coreBlockCategories,
  coreBlockDefinitions,
  registerCoreBlocks,
  rootFieldsPage,
  rootFieldsPost,
} from "../coreBlocks";
import {
  ANIM_DELAY_MAX,
  ANIM_DURATION_MAX,
  ANIM_DURATION_MIN,
  clampAnimSpec,
  sharedFieldDefaults,
  withSharedVersoFields,
} from "../sharedFields";
import { createBlockRegistry, makeSlotResolver, type BlockDefinition } from "../registry";
import { postConfig, pageConfig } from "@/components/versoConfig";
import { GENERATED_CORE_BLOCK_REGISTRY } from "@/generated/verso-registry.generated";

/* ------------------------------------------------------------------ */
/* Utilidades de comparación.                                          */
/* ------------------------------------------------------------------ */

/** Sustituye funciones por un marcador estable para poder deep-equal el resto del objeto. */
function stripFunctions(value: unknown): unknown {
  if (typeof value === "function") return "[fn]";
  if (Array.isArray(value)) return value.map(stripFunctions);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripFunctions(v);
    }
    return out;
  }
  return value;
}

/** Las definiciones Verso YA envueltas por el seam (lo que registra registerCoreBlocks). */
const wrappedByType = new Map<string, BlockDefinition>(
  coreBlockDefinitions.map((def) => [def.type, withSharedVersoFields(def)]),
);

const configComponents = (postConfig as { components: Record<string, Record<string, unknown>> }).components;

/* ------------------------------------------------------------------ */
/* 1. El contrato generado de tipos, categorías y slots.                */
/* ------------------------------------------------------------------ */

describe("coreBlocks — contrato de tipos", () => {
  it("cada implementación coincide con el registro generado", () => {
    expect([...CORE_BLOCK_TYPES]).toEqual(GENERATED_CORE_BLOCK_REGISTRY.map((block) => block.type));
    expect(coreBlockDefinitions.map((definition) => definition.type).sort())
      .toEqual(GENERATED_CORE_BLOCK_REGISTRY.map((block) => block.type).sort());
    for (const block of GENERATED_CORE_BLOCK_REGISTRY) {
      const definition = coreBlockDefinitions.find((candidate) => candidate.type === block.type);
      expect(definition?.category, `${block.type}: categoría`).toBe(block.category);
      expect(Object.entries(definition?.fields ?? {}).filter(([, field]) => field.type === "slot").map(([name]) => name), `${block.type}: slots`)
        .toEqual(block.slots);
    }
  });

  it("cada type existe también en el registro de bloques de versoConfig.components", () => {
    for (const type of CORE_BLOCK_TYPES) {
      expect(configComponents[type], `versoConfig no tiene ${type}`).toBeDefined();
    }
  });

  it("las 5 categorías actuales están presentes y cada bloque usa una clave conocida", () => {
    expect(Object.keys(coreBlockCategories)).toEqual([
      "layout",
      "content",
      "Card Gallery",
      "Video Gallery",
      "Photo Carousel",
    ]);
    for (const def of coreBlockDefinitions) {
      expect(def.category, `${def.type} sin categoría válida`).toBeDefined();
      expect(Object.keys(coreBlockCategories)).toContain(def.category);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Anti-drift: defaultProps y fields contra versoConfig IMPORTADO.    */
/* ------------------------------------------------------------------ */

describe("coreBlocks — anti-drift contra versoConfig (programático)", () => {
  for (const type of CORE_BLOCK_TYPES) {
    it(`${type}: defaultProps deep-equal (incluye hide/anim/look del seam)`, () => {
      const verso = wrappedByType.get(type);
      const config = configComponents[type];
      expect(verso).toBeDefined();
      expect(config).toBeDefined();
      // versoConfig ya está envuelto por withSharedBlockFields en módulo, así que ambos lados
      // llevan los defaults compartidos — el seam Verso debe producir EXACTAMENTE los mismos.
      expect(verso!.defaultProps).toEqual(config!.defaultProps);
    });

    it(`${type}: fields con la misma semántica (claves en orden, types, labels, options)`, () => {
      const verso = wrappedByType.get(type)!;
      const config = configComponents[type]! as { fields: Record<string, unknown> };
      // Mismo conjunto Y mismo orden de claves (el orden es el del panel de propiedades).
      expect(Object.keys(verso.fields)).toEqual(Object.keys(config.fields));
      // Igualdad estructural del resto (funciones → marcador).
      expect(stripFunctions(verso.fields)).toEqual(stripFunctions(config.fields));
    });

    it(`${type}: label y categoría idénticos a versoConfig`, () => {
      const verso = wrappedByType.get(type)!;
      const config = configComponents[type]! as { label?: string; category?: string };
      expect(verso.label).toEqual(config.label);
      expect(verso.category).toEqual(config.category);
    });
  }
});

/* ------------------------------------------------------------------ */
/* 3. Slots: makeSlotResolver responde como el editor actual.           */
/* ------------------------------------------------------------------ */

describe("coreBlocks — resolución de slots", () => {
  const registry = createBlockRegistry();
  registerCoreBlocks(registry);
  const isSlot = makeSlotResolver(registry);

  it("los contenedores declaran sus slots exactos", () => {
    expect(isSlot("Section", "children")).toBe(true);
    expect(isSlot("Grid", "children")).toBe(true);
    expect(isSlot("FlexRow", "children")).toBe(true);
    expect(isSlot("Columns", "col-0")).toBe(true);
    expect(isSlot("Columns", "col-1")).toBe(true);
    expect(isSlot("Columns", "col-2")).toBe(true);
    expect(isSlot("OffCanvas", "content")).toBe(true);
    // MegaMenu: el conjunto FIJO de paneles (mecanismo Columns), y las props de VÍNCULO no son slots.
    for (const panel of ["panel0", "panel1", "panel2", "panel3", "panel4", "panel5"]) {
      expect(isSlot("MegaMenu", panel)).toBe(true);
    }
    expect(isSlot("MegaMenu", "source")).toBe(false);
    expect(isSlot("MegaMenu", "location")).toBe(false);
    expect(isSlot("MegaMenu", "menuId")).toBe(false);
  });

  it("un array item-shaped NUNCA es slot (Accordion.items, Tabs.tabs, PricingTable.plans…)", () => {
    expect(isSlot("Accordion", "items")).toBe(false);
    expect(isSlot("Tabs", "tabs")).toBe(false);
    expect(isSlot("PricingTable", "plans")).toBe(false);
    expect(isSlot("Hero", "buttons")).toBe(false);
    expect(isSlot("Table", "rows")).toBe(false);
  });

  it("Card no tiene slots; sus props son planas", () => {
    expect(isSlot("Card", "title")).toBe(false);
    expect(isSlot("Card", "description")).toBe(false);
    const card = registry.get("Card")!;
    expect(Object.values(card.fields).some((f) => f.type === "slot")).toBe(false);
  });

  it("campos inyectados por el seam están declarados no-slot; tipo desconocido → undefined", () => {
    expect(isSlot("Section", "hide")).toBe(false);
    expect(isSlot("Section", "anim")).toBe(false);
    expect(isSlot("Section", "look")).toBe(false);
    expect(isSlot("NoExiste", "children")).toBeUndefined();
    // Campo no declarado en un tipo registrado → sin opinión (detección estructural).
    expect(isSlot("Section", "loQueSea")).toBeUndefined();
  });

  it("el registry queda con exactamente 39 definiciones", () => {
    expect(registry.list()).toHaveLength(39);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Inline: los 2 actuales + la extensión ratificada.                 */
/* ------------------------------------------------------------------ */

describe("coreBlocks — edición inline declarada", () => {
  const inlineOf = (type: string) => wrappedByType.get(type)!.inline;

  it("Text.content rich y Heading.title plain (paridad con el editor actual)", () => {
    expect(inlineOf("Text")).toEqual({ prop: "content", schema: "rich" });
    expect(inlineOf("Heading")).toEqual({ prop: "title", schema: "plain" });
  });

  it("extensión del programa: Quote.text, Button.label, Card.title, CTABanner.title (plain)", () => {
    expect(inlineOf("Quote")).toEqual({ prop: "text", schema: "plain" });
    expect(inlineOf("Button")).toEqual({ prop: "label", schema: "plain" });
    expect(inlineOf("Card")).toEqual({ prop: "title", schema: "plain" });
    expect(inlineOf("CTABanner")).toEqual({ prop: "title", schema: "plain" });
  });

  it("nadie más declara inline", () => {
    const withInline = coreBlockDefinitions.filter((d) => d.inline).map((d) => d.type).sort();
    expect(withInline).toEqual(["Button", "CTABanner", "Card", "Heading", "Quote", "Text"].sort());
  });
});

/* ------------------------------------------------------------------ */
/* 5. Seam: clamps de anim y opt-out.                                   */
/* ------------------------------------------------------------------ */

describe("sharedFields — clamps de seguridad de anim (100–3000ms)", () => {
  it("clampa duration y delay fuera de rango", () => {
    expect(clampAnimSpec({ type: "fade", duration: 5, delay: 999999 })).toEqual({
      type: "fade",
      duration: ANIM_DURATION_MIN,
      delay: ANIM_DELAY_MAX,
    });
    expect(clampAnimSpec({ type: "fade", duration: 3001 })).toEqual({
      type: "fade",
      duration: ANIM_DURATION_MAX,
    });
    expect(clampAnimSpec({ type: "fade", delay: -50 })).toEqual({ type: "fade", delay: 0 });
  });

  it("no inventa claves ausentes ni toca las que están en rango", () => {
    expect(clampAnimSpec({ type: "fade-up" })).toEqual({ type: "fade-up" });
    expect(clampAnimSpec({ type: "zoom", duration: 600, delay: 0 })).toEqual({
      type: "zoom",
      duration: 600,
      delay: 0,
    });
    expect(clampAnimSpec(undefined)).toEqual({});
  });

  it("los defaults compartidos son los del wrapper actual y objetos frescos por llamada", () => {
    const a = sharedFieldDefaults();
    expect(a).toEqual({ hide: {}, anim: { type: "fade-up", duration: 600, delay: 0 }, look: {} });
    const b = sharedFieldDefaults();
    expect(b).not.toBe(a);
    expect(b.anim).not.toBe(a.anim);
  });
});

describe("sharedFields — withSharedVersoFields", () => {
  it("inyecta hide/anim/look como custom con los labels literales del editor actual", () => {
    const def: BlockDefinition = {
      type: "X",
      fields: { foo: { type: "text" } },
      defaultProps: { foo: "bar" },
      render: () => null,
    };
    const wrapped = withSharedVersoFields(def);
    expect(wrapped).not.toBe(def);
    expect(Object.keys(wrapped.fields)).toEqual(["foo", "hide", "anim", "look"]);
    expect(wrapped.fields.hide).toMatchObject({ type: "custom", label: "Visibilidad por dispositivo" });
    expect(wrapped.fields.anim).toMatchObject({ type: "custom", label: "Animación de entrada" });
    expect(wrapped.fields.look).toMatchObject({ type: "custom", label: "Apariencia" });
    expect(wrapped.defaultProps).toEqual({ foo: "bar", ...sharedFieldDefaults() });
    // El render NO se toca: el wrapper visual lo pone VersoBlock vía SharedBlockShell.
    expect(wrapped.render).toBe(def.render);
  });

  it("opt-out: una definición con fields.hide propio se devuelve INTACTA (misma referencia)", () => {
    const def: BlockDefinition = {
      type: "OptOut",
      fields: { hide: { type: "text", label: "custom hide propio" } },
      defaultProps: {},
      render: () => null,
    };
    expect(withSharedVersoFields(def)).toBe(def);
  });

  it("opt-out: una definición sin render tampoco se envuelve (paridad con withSharedBlockFields)", () => {
    const def: BlockDefinition = {
      type: "NoRender",
      fields: {},
      defaultProps: {},
      render: undefined,
    };
    expect(withSharedVersoFields(def)).toBe(def);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Campos ROOT: la asimetría post/page se porta, no se colapsa.      */
/* ------------------------------------------------------------------ */

describe("coreBlocks — rootFieldsPost / rootFieldsPage", () => {
  const configPostRoot = (postConfig as { root: { fields: Record<string, unknown> } }).root.fields;
  const configPageRoot = (pageConfig as { root: { fields: Record<string, unknown> } }).root.fields;

  it("rootFieldsPost coincide byte a byte (estructura) con postConfig.root.fields", () => {
    expect(Object.keys(rootFieldsPost)).toEqual(Object.keys(configPostRoot));
    expect(stripFunctions(rootFieldsPost)).toEqual(stripFunctions(configPostRoot));
  });

  it("rootFieldsPage coincide con pageConfig.root.fields", () => {
    expect(Object.keys(rootFieldsPage)).toEqual(Object.keys(configPageRoot));
    expect(stripFunctions(rootFieldsPage)).toEqual(stripFunctions(configPageRoot));
  });

  it("la asimetría se conserva: SEO/category/allowComments SOLO en post", () => {
    for (const key of ["category", "allowComments", "seo_title", "seo_description", "og_image", "noindex"]) {
      expect(rootFieldsPost[key], `falta ${key} en post`).toBeDefined();
      expect(rootFieldsPage[key], `${key} no debe existir en page`).toBeUndefined();
    }
    // Y ambos comparten título/slug/plantilla.
    for (const key of ["title", "slug", "_wjs_template"]) {
      expect(rootFieldsPost[key]).toBeDefined();
      expect(rootFieldsPage[key]).toBeDefined();
    }
  });
});
