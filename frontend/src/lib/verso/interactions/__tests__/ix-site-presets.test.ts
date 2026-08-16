/**
 * Verso — interacciones F9-E: el AJUSTE del sitio (`wjs_ix_presets`) y el recolector de la página.
 *
 * Estos dos módulos son la frontera entre "dato que alguien escribió" y el compilador. Lo que se
 * prueba aquí no es que funcionen con datos buenos —eso es el suelo— sino que con datos MALOS
 * fallan hacia abierto: catálogo vacío, página entera, nunca una excepción ni contenido oculto.
 */
import { describe, expect, it } from "vitest";
import {
  collectIxSpecs,
  compileIxPage,
  ixCtxFromSetting,
  ixCtxFromSite,
  parseSiteIxPresets,
  serializeSiteIxPresets,
  IX_COLLECT_MAX_DEPTH,
  IX_MAX_SITE_PRESETS,
  IX_PRESETS_MAX_BYTES,
  SYS_IX_PRESETS,
} from "..";
import type { IxPreset } from "..";

const preset = (id: string, extra: Partial<IxPreset> = {}): Record<string, unknown> => ({
  id,
  name: `Preajuste ${id}`,
  trigger: { on: "view", once: true },
  tracks: [
    {
      target: { kind: "self" },
      steps: [
        { at: 0, set: { opacity: 0 } },
        { at: 100, set: { opacity: 1 } },
      ],
    },
  ],
  rev: 1,
  ...extra,
});

describe("parseSiteIxPresets — la frontera de lectura del ajuste", () => {
  it("acepta la cadena JSON que guarda la opción", () => {
    const out = parseSiteIxPresets(JSON.stringify([preset("aparecer-tarjetas")]));
    expect(Object.keys(out)).toEqual(["aparecer-tarjetas"]);
    expect(out["aparecer-tarjetas"].name).toBe("Preajuste aparecer-tarjetas");
  });

  it("acepta también el valor ya parseado (array y mapa)", () => {
    expect(Object.keys(parseSiteIxPresets([preset("a")]))).toEqual(["a"]);
    expect(Object.keys(parseSiteIxPresets({ a: preset("a") }))).toEqual(["a"]);
  });

  it("vacío ante cualquier cosa que no sea un catálogo", () => {
    for (const bad of [null, undefined, "", "   ", 42, true, "no soy json", "{", [1, 2, 3], {}]) {
      expect(parseSiteIxPresets(bad)).toEqual({});
    }
  });

  it("NUNCA lanza, ni con JSON válido lleno de basura", () => {
    const hostile = JSON.stringify([
      { id: "sin-tracks" },
      { id: 12 },
      { tracks: [] },
      null,
      "cadena",
      { id: "ok-pero-pasos-rotos", tracks: [{ target: { kind: "self" }, steps: [{ at: 0 }] }] },
    ]);
    expect(() => parseSiteIxPresets(hostile)).not.toThrow();
    expect(parseSiteIxPresets(hostile)).toEqual({});
  });

  it("el espacio de nombres `sys:` está RESERVADO: un ajuste no puede suplantar un preset de sistema", () => {
    const out = parseSiteIxPresets(JSON.stringify([preset("sys:fade-up"), preset("propio")]));
    expect(Object.keys(out)).toEqual(["propio"]);
  });

  it("descarta un id que no sea un slug (no llega al selector de atributo del runtime)", () => {
    const out = parseSiteIxPresets(
      JSON.stringify([preset('mal"][onload=alert(1)]'), preset("bien")]),
    );
    expect(Object.keys(out)).toEqual(["bien"]);
  });

  it("respeta el tope de presets y el de bytes ANTES de parsear", () => {
    const many = Array.from({ length: IX_MAX_SITE_PRESETS + 10 }, (_, i) => preset(`p${i}`));
    expect(Object.keys(parseSiteIxPresets(JSON.stringify(many)))).toHaveLength(IX_MAX_SITE_PRESETS);

    const huge = `[${" ".repeat(IX_PRESETS_MAX_BYTES + 1)}]`;
    expect(parseSiteIxPresets(huge)).toEqual({});
  });

  it("id duplicado: gana el primero, determinista", () => {
    const out = parseSiteIxPresets(
      JSON.stringify([preset("dup", { name: "primero" }), preset("dup", { name: "segundo" })]),
    );
    expect(out.dup.name).toBe("primero");
  });
});

describe("ixCtxFromSite — el catálogo que ve el compilador", () => {
  it("sin presets de sitio, EXACTAMENTE los del sistema", () => {
    expect(ixCtxFromSite(null).presets).toBe(SYS_IX_PRESETS);
    expect(ixCtxFromSite({}).presets).toBe(SYS_IX_PRESETS);
  });

  it("los del sistema NO se pueden pisar, ni forzando la colisión en el mapa", () => {
    const forged = { "sys:fade-up": { ...SYS_IX_PRESETS["sys:fade-up"], name: "SECUESTRADO" } };
    const ctx = ixCtxFromSite(forged as Record<string, IxPreset>);
    expect(ctx.presets!["sys:fade-up"].name).toBe(SYS_IX_PRESETS["sys:fade-up"].name);
  });

  it("suma los del sitio a los del sistema", () => {
    const ctx = ixCtxFromSetting(JSON.stringify([preset("propio")]));
    expect(ctx.presets!["propio"]).toBeDefined();
    expect(ctx.presets!["sys:fade-up"]).toBeDefined();
  });
});

describe("serializeSiteIxPresets — ida y vuelta", () => {
  it("lo guardado se vuelve a leer igual, y el orden no depende del de inserción", () => {
    const a = parseSiteIxPresets(JSON.stringify([preset("zzz"), preset("aaa")]));
    const b = parseSiteIxPresets(serializeSiteIxPresets(a));
    expect(b).toEqual(a);
    expect(serializeSiteIxPresets(a)).toBe(serializeSiteIxPresets(b));
  });
});

/* ------------------------------------------------------------------ */
/* El recolector                                                       */
/* ------------------------------------------------------------------ */

describe("collectIxSpecs — las `ix` de una página", () => {
  it("recoge las de primer nivel y las de los slots anidados, en orden", () => {
    const data = {
      content: [
        { type: "Heading", props: { id: "h", ix: { v: 1, preset: "a" } } },
        {
          type: "Section",
          props: {
            id: "s",
            ix: { v: 1, preset: "b" },
            children: [
              { type: "Text", props: { id: "t", ix: { v: 1, preset: "c" } } },
              { type: "Text", props: { id: "t2" } },
            ],
          },
        },
      ],
    };
    expect(collectIxSpecs(data)).toEqual([
      { v: 1, preset: "a" },
      { v: 1, preset: "b" },
      { v: 1, preset: "c" },
    ]);
  });

  it("un array de props que NO es un slot (filas de una tabla) no se recorre", () => {
    const data = {
      content: [{ type: "Table", props: { id: "t", rows: [["a", "b"], ["c"]], ix: { v: 1 } } }],
    };
    expect(collectIxSpecs(data)).toEqual([{ v: 1 }]);
  });

  it("dato sin forma de página → lista vacía, sin lanzar", () => {
    for (const bad of [null, undefined, 42, "x", {}, { content: "no" }, { content: [null, 1] }]) {
      expect(collectIxSpecs(bad)).toEqual([]);
    }
  });

  it("un árbol absurdamente profundo se corta en el tope, y la página se sigue sirviendo", () => {
    // Anidamiento muy por encima del tope: lo que se prueba es que TERMINA y no revienta.
    let node: Record<string, unknown> = { type: "Text", props: { ix: { v: 1, preset: "hondo" } } };
    for (let i = 0; i < IX_COLLECT_MAX_DEPTH + 10; i++) {
      node = { type: "Section", props: { children: [node] } };
    }
    const specs = collectIxSpecs({ content: [node] });
    expect(specs.length).toBe(0); // el bloque del fondo queda fuera: se ve, no se mueve
    expect(() => collectIxSpecs({ content: [node] })).not.toThrow();
  });

  it("un ciclo en el dato no cuelga el render (tope de nodos)", () => {
    const a: Record<string, unknown> = { type: "Section", props: {} };
    (a.props as Record<string, unknown>).children = [a];
    expect(() => collectIxSpecs({ content: [a] })).not.toThrow();
  });
});

describe("recolector + compilador: el camino real de una página", () => {
  it("N bloques con el mismo preajuste emiten UNA clase y UN juego de reglas", () => {
    const data = {
      content: Array.from({ length: 12 }, (_, i) => ({
        type: "Card",
        props: { id: `c${i}`, ix: { v: 1, preset: "sys:fade-up" } },
      })),
    };
    const page = compileIxPage(collectIxSpecs(data), ixCtxFromSite(null));
    expect(page.units).toHaveLength(1);
    expect(page.css).toContain(page.units[0].cls);
  });

  it("un preajuste de SITIO compila igual que uno de sistema", () => {
    const ctx = ixCtxFromSetting(JSON.stringify([preset("propio")]));
    const page = compileIxPage([{ v: 1, preset: "propio" }], ctx);
    expect(page.units).toHaveLength(1);
    expect(page.css).toContain("@keyframes");
  });

  it("editar el preajuste (rev++) cambia el hash → el navegador no puede servir CSS viejo", () => {
    const v1 = ixCtxFromSetting(JSON.stringify([preset("propio", { rev: 1 })]));
    const v2 = ixCtxFromSetting(JSON.stringify([preset("propio", { rev: 2 })]));
    const a = compileIxPage([{ v: 1, preset: "propio" }], v1);
    const b = compileIxPage([{ v: 1, preset: "propio" }], v2);
    expect(a.units[0].cls).not.toBe(b.units[0].cls);
  });

  it("referencia rota (preajuste borrado): sin unidad, sin CSS y sin runtime — el bloque se ve", () => {
    const page = compileIxPage([{ v: 1, preset: "ya-no-existe" }], ixCtxFromSite(null));
    expect(page.units).toHaveLength(0);
    expect(page.css).toBe("");
    expect(page.runtime).toHaveLength(0);
  });

  it("TODO el CSS emitido vive bajo `prefers-reduced-motion: no-preference`", () => {
    const page = compileIxPage([{ v: 1, preset: "sys:fade-up" }], ixCtxFromSite(null));
    expect(page.css.startsWith("@media screen and (prefers-reduced-motion:no-preference){")).toBe(
      true,
    );
  });
});
