/**
 * GATE F2 — registro de bloques versionado.
 *
 * Cubre: identidad estable del objeto raíz, version()/subscribe(), los dos adaptadores legacy con
 * fixtures que reproducen la forma REAL de un plugin single-block (Testimonials) y uno multi-block
 * (OnlineStore) — ver documentation/verso/legacy-surface.md §6 —, y makeSlotResolver() integrado con
 * toNormalized() (el caso que separa `array` item-shaped de `slot` vacío).
 */

import { describe, expect, it, vi } from "vitest";
import {
  adaptLegacyMulti,
  adaptLegacySingle,
  createBlockRegistry,
  makeSlotResolver,
  type BlockDefinition,
  type LegacyMultiBlockDef,
  type LegacySingleBlockDef,
} from "../registry";
import { toNormalized } from "../normalize";
import type { VersoData } from "../types";

const emptyDef = (type: string): BlockDefinition => ({
  type,
  fields: {},
  defaultProps: {},
  render: null,
});

describe("createBlockRegistry — identidad estable", () => {
  it("el objeto raíz es el MISMO antes y después de múltiples register()", () => {
    const registry = createBlockRegistry();
    const ref = registry;
    registry.register(emptyDef("A"));
    registry.register([emptyDef("B"), emptyDef("C")]);
    registry.register(emptyDef("A")); // upsert
    expect(registry).toBe(ref);
  });

  it("dos llamadas a createBlockRegistry() producen instancias independientes (no un singleton módulo)", () => {
    const r1 = createBlockRegistry();
    const r2 = createBlockRegistry();
    r1.register(emptyDef("A"));
    expect(r1.list()).toHaveLength(1);
    expect(r2.list()).toHaveLength(0);
    expect(r1).not.toBe(r2);
  });
});

describe("createBlockRegistry — version()", () => {
  it("arranca en 0 y sube exactamente 1 por CADA llamada a register(), sin importar cuántas defs traiga", () => {
    const registry = createBlockRegistry();
    expect(registry.version()).toBe(0);

    registry.register(emptyDef("A"));
    expect(registry.version()).toBe(1);

    registry.register([emptyDef("B"), emptyDef("C"), emptyDef("D")]);
    expect(registry.version()).toBe(2);

    registry.register(emptyDef("A")); // upsert también cuenta como bump
    expect(registry.version()).toBe(3);
  });
});

describe("createBlockRegistry — subscribe()", () => {
  it("notifica en cada bump y no vuelve a notificar tras desuscribirse", () => {
    const registry = createBlockRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.register(emptyDef("A"));
    expect(listener).toHaveBeenCalledTimes(1);

    registry.register(emptyDef("B"));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.register(emptyDef("C"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("varios listeners activos reciben el mismo bump de forma independiente", () => {
    const registry = createBlockRegistry();
    const a = vi.fn();
    const b = vi.fn();
    registry.subscribe(a);
    const unsubB = registry.subscribe(b);
    unsubB(); // b se retira antes de registrar nada

    registry.register(emptyDef("A"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});

describe("createBlockRegistry — get()/list()", () => {
  it("get() devuelve undefined para un type no registrado", () => {
    const registry = createBlockRegistry();
    expect(registry.get("Nope")).toBeUndefined();
  });

  it("re-registrar el mismo type es upsert: reemplaza la definición, no la duplica", () => {
    const registry = createBlockRegistry();
    const v1: BlockDefinition = { ...emptyDef("A"), label: "v1" };
    const v2: BlockDefinition = { ...emptyDef("A"), label: "v2" };
    registry.register(v1);
    registry.register(v2);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("A")).toEqual(v2);
  });

  it("list() es un snapshot nuevo cada vez pero refleja el mismo estado", () => {
    const registry = createBlockRegistry();
    registry.register([emptyDef("A"), emptyDef("B")]);
    const l1 = registry.list();
    const l2 = registry.list();
    expect(l1).not.toBe(l2); // arrays distintos...
    expect(l1).toEqual(l2); // ...mismo contenido
    expect(l1.map((d) => d.type).sort()).toEqual(["A", "B"]);
  });
});

/* ------------------------------------------------------------------ */
/* Adaptadores legacy — fixtures que reproducen plugins reales.        */
/* ------------------------------------------------------------------ */

// Fixture single-block: forma EXACTA de marketplace/plugins/testimonials/client/verso/TestimonialsVerso.tsx
// (el nombre de export histórico `puckComponentDef` sin render — el generador lo compone aparte; se
// conserva a propósito porque este fixture cubre el canal de compatibilidad, no el actual).
const testimonialsLegacyDef: LegacySingleBlockDef = {
  category: "Testimonios",
  fields: {
    mode: {
      type: "radio",
      label: "Modo de visualización",
      options: [
        { label: "Carrusel", value: "carousel" },
        { label: "Cuadrícula", value: "grid" },
      ],
    },
    maxItems: { type: "number", label: "Máximo de testimonios" },
    showRating: {
      type: "radio",
      label: "Mostrar calificación",
      options: [
        { label: "Sí", value: true },
        { label: "No", value: false },
      ],
    },
    elementId: { type: "text", label: "ID / Ancla (opcional)" },
  },
  defaultProps: {
    mode: "carousel",
    maxItems: 9,
    showRating: true,
    showPhotos: true,
    showSubmitForm: false,
    elementId: "",
  },
};
function TestimonialsRender() {
  return null;
}

describe("adaptLegacySingle — fixture single-block real (Testimonials)", () => {
  it("compone {type, render} tal como generate-verso-plugin-registry.js:167-171", () => {
    const def = adaptLegacySingle(testimonialsLegacyDef, TestimonialsRender, "Testimonials");
    expect(def.type).toBe("Testimonials");
    expect(def.category).toBe("Testimonios");
    expect(def.render).toBe(TestimonialsRender);
    expect(def.defaultProps).toEqual(testimonialsLegacyDef.defaultProps);
    expect(def.fields.mode).toEqual(testimonialsLegacyDef.fields.mode);
  });

  it("se registra sin fricción en un BlockRegistry", () => {
    const registry = createBlockRegistry();
    registry.register(adaptLegacySingle(testimonialsLegacyDef, TestimonialsRender, "Testimonials"));
    expect(registry.get("Testimonials")?.render).toBe(TestimonialsRender);
  });
});

// Fixture multi-block: forma EXACTA de marketplace/plugins/online-store/client/verso/OnlineStoreVerso.tsx
// (nombre de export histórico: `export const puckComponents = { OnlineStore: {...def, render},
// StoreOrders: {...def, render} }` — conservado a propósito, es el canal de compatibilidad).
function OnlineStoreRender() {
  return null;
}
function StoreOrdersRender() {
  return null;
}
const onlineStorePuckComponents: Record<string, LegacyMultiBlockDef> = {
  OnlineStore: {
    category: "Tienda",
    fields: {
      category: { type: "text", label: "Categoría (vacío = todas)" },
      columns: {
        type: "radio",
        label: "Columnas",
        options: [
          { label: "2", value: 2 },
          { label: "3", value: 3 },
        ],
      },
    },
    defaultProps: { category: "", columns: 3, showSearch: true },
    render: OnlineStoreRender,
  },
  StoreOrders: {
    category: "Tienda",
    fields: { title: { type: "text", label: "Título (vacío = sin título)" } },
    defaultProps: { title: "Mis pedidos", elementId: "" },
    render: StoreOrdersRender,
  },
};

describe("adaptLegacyMulti — fixture multi-block real (OnlineStore)", () => {
  it("expande el mapa a un BlockDefinition por entrada, la CLAVE del mapa es el type", () => {
    const defs = adaptLegacyMulti(onlineStorePuckComponents);
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.type).sort()).toEqual(["OnlineStore", "StoreOrders"]);

    const store = defs.find((d) => d.type === "OnlineStore");
    expect(store?.render).toBe(OnlineStoreRender);
    expect(store?.category).toBe("Tienda");

    const orders = defs.find((d) => d.type === "StoreOrders");
    expect(orders?.render).toBe(StoreOrdersRender);
    expect(orders?.defaultProps).toEqual({ title: "Mis pedidos", elementId: "" });
  });

  it("register() acepta directo el array devuelto por el adaptador", () => {
    const registry = createBlockRegistry();
    registry.register(adaptLegacyMulti(onlineStorePuckComponents));
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("OnlineStore")?.fields.columns.type).toBe("radio");
  });
});

/* ------------------------------------------------------------------ */
/* makeSlotResolver — integrado con toNormalized.                      */
/* ------------------------------------------------------------------ */

describe("makeSlotResolver", () => {
  it("type no registrado → undefined (normalize.ts cae a detección estructural)", () => {
    const registry = createBlockRegistry();
    const isSlot = makeSlotResolver(registry);
    expect(isSlot("Unknown", "items")).toBeUndefined();
  });

  it("campo no declarado en un type SÍ registrado → undefined, no false", () => {
    const registry = createBlockRegistry();
    registry.register({
      type: "Card",
      fields: { title: { type: "text" } },
      defaultProps: {},
      render: null,
    });
    const isSlot = makeSlotResolver(registry);
    // "hide" lo inyecta withSharedBlockFields POR FUERA de fields — el registro no tiene opinión.
    expect(isSlot("Card", "hide")).toBeUndefined();
  });

  it('campo declarado type:"array" (item-shaped) → false SIEMPRE, nunca se reclasifica por la forma del valor', () => {
    const registry = createBlockRegistry();
    registry.register({
      type: "Weird",
      fields: { rows: { type: "array", arrayFields: { id: { type: "text" } } } },
      defaultProps: { rows: [] },
      render: null,
    });
    const isSlot = makeSlotResolver(registry);
    expect(isSlot("Weird", "rows")).toBe(false);
  });

  it('campo declarado type:"slot" → true, incluso vacío', () => {
    const registry = createBlockRegistry();
    registry.register({
      type: "Grid",
      fields: { items: { type: "slot" } },
      defaultProps: { items: [] },
      render: null,
    });
    const isSlot = makeSlotResolver(registry);
    expect(isSlot("Grid", "items")).toBe(true);
  });

  it("integrado con toNormalized: un array item-shaped declarado `array` NO se indexa como hijo — queda prop verbatim", () => {
    const registry = createBlockRegistry();
    registry.register({
      type: "Weird",
      fields: { rows: { type: "array", arrayFields: { id: { type: "text" } } } },
      defaultProps: {},
      render: null,
    });
    const isSlot = makeSlotResolver(registry);

    const data: VersoData = {
      content: [{ type: "Weird", props: { id: "w1", rows: [{ type: "Fake", props: { id: "f1" } }] } }],
      root: { props: {} },
    };
    const doc = toNormalized(data, isSlot);

    expect(doc.nodes.f1).toBeUndefined(); // "Fake" no se indexó como nodo hijo
    expect(doc.nodes.w1.slots).toEqual({}); // Weird no tiene slots
    expect(doc.nodes.w1.props.rows).toEqual(data.content[0].props.rows); // sobrevive como prop verbatim
  });

  it("integrado con toNormalized: un slot declarado vacío SÍ se indexa como slot (no como prop)", () => {
    const registry = createBlockRegistry();
    registry.register({
      type: "Grid",
      fields: { items: { type: "slot" } },
      defaultProps: {},
      render: null,
    });
    const isSlot = makeSlotResolver(registry);

    const data: VersoData = {
      content: [{ type: "Grid", props: { id: "g1", items: [] } }],
      root: { props: {} },
    };
    const doc = toNormalized(data, isSlot);

    expect(doc.nodes.g1.slots.items).toEqual([]);
    expect(doc.nodes.g1.props.items).toBeUndefined();
  });

  it("integrado con toNormalized: un slot declarado con hijos reales se indexa y el orden se preserva", () => {
    const registry = createBlockRegistry();
    registry.register({
      type: "Columns",
      fields: { "col-0": { type: "slot" }, "col-1": { type: "slot" } },
      defaultProps: {},
      render: null,
    });
    const isSlot = makeSlotResolver(registry);

    const data: VersoData = {
      content: [
        {
          type: "Columns",
          props: {
            id: "col1",
            "col-0": [
              { type: "Text", props: { id: "t1" } },
              { type: "Text", props: { id: "t2" } },
            ],
          },
        },
      ],
      root: { props: {} },
    };
    const doc = toNormalized(data, isSlot);

    expect(doc.nodes.col1.slots["col-0"]).toEqual(["t1", "t2"]);
    expect(doc.nodes.t1.parentId).toBe("col1");
    expect(doc.nodes.t1.slotKey).toBe("col-0");
  });
});
