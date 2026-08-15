/**
 * Verso — tests de VersoFieldControl (los 10 tipos de VersoField).
 *
 * ENTORNO node sin jsdom (ver editorRenderer.test.tsx): el markup se verifica
 * con renderToStaticMarkup y el mapeo interacción→onChange se verifica sobre
 * los helpers PUROS de fieldHelpers.ts, que son exactamente lo que los
 * handlers de los controles invocan. El único onChange end-to-end posible sin
 * DOM es el de `custom` (field.render recibe el callback y puede invocarlo).
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArrayVersoField, VersoField } from "@/lib/verso/registry";
import VersoFieldControl from "../VersoFieldControl";
import {
  arrayAppend,
  arrayMove,
  arrayPatchItem,
  arrayRemoveAt,
  asArrayItems,
  asObjectValue,
  canAddItem,
  canRemoveItem,
  objectSet,
  optionIndexOf,
  optionValueAt,
  parseNumberInput,
} from "../fieldHelpers";

const noop = (): void => undefined;

function render(field: VersoField, value: unknown, extra?: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <VersoFieldControl field={field} value={value} onChange={noop} {...extra} />,
  );
}

describe("VersoFieldControl — markup y accesibilidad por tipo", () => {
  it("text: input con valor, placeholder y label asociado por id", () => {
    const html = render({ type: "text", label: "Título", placeholder: "Escribe…" }, "hola");
    expect(html).toContain('type="text"');
    expect(html).toContain('value="hola"');
    expect(html).toContain('placeholder="Escribe…"');
    expect(html).toContain(">Título</label>");
    const forId = html.match(/for="([^"]+)"/);
    expect(forId).not.toBeNull();
    expect(html).toContain(`id="${forId![1]}"`);
  });

  it("textarea: valor y label", () => {
    const html = render({ type: "textarea", label: "Cuerpo" }, "línea");
    expect(html).toContain("<textarea");
    expect(html).toContain("línea</textarea>");
    expect(html).toContain(">Cuerpo</label>");
  });

  it("number: min/max/step y valor numérico", () => {
    const html = render({ type: "number", label: "Ancho", min: 0, max: 10, step: 2 }, 4);
    expect(html).toContain('type="number"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="10"');
    expect(html).toContain('step="2"');
    expect(html).toContain('value="4"');
    // Valor no numérico → input vacío (no revienta).
    expect(render({ type: "number", label: "Ancho" }, "raro")).toContain('value=""');
  });

  it("select: opciones por índice y la actual seleccionada (values no-string)", () => {
    const field: VersoField = {
      type: "select",
      label: "Columnas",
      options: [
        { label: "Una", value: 1 },
        { label: "Dos", value: 2 },
        { label: "Ninguna", value: null },
      ],
    };
    const html = render(field, 2);
    expect(html).toContain("<select");
    expect(html).toContain(">Una</option>");
    expect(html).toContain(">Dos</option>");
    expect(html).toContain(">Ninguna</option>");
    // React SSR marca la opción controlada con selected — y solo esa.
    expect(html).toMatch(/<option[^>]*selected[^>]*>Dos<\/option>/);
    expect(html.match(/selected/g)).toHaveLength(1);
  });

  it("radio: fieldset/legend, radiogroup con aria-label y exactamente un checked", () => {
    const field: VersoField = {
      type: "radio",
      label: "Visible",
      options: [
        { label: "Sí", value: true },
        { label: "No", value: false },
      ],
    };
    const html = render(field, false);
    expect(html).toContain("<fieldset");
    expect(html).toContain(">Visible</legend>");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Visible"');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    // Los dos radios comparten name de grupo.
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(names[1]);
  });

  it("array: items con resumen, sub-campos y botones añadir/quitar/reordenar con aria-label", () => {
    const field: ArrayVersoField = {
      type: "array",
      label: "Lista",
      arrayFields: { t: { type: "text", label: "Texto" } },
      getItemSummary: (item) => String(item.t),
      max: 2,
    };
    const html = render(field, [{ t: "uno" }, { t: "dos" }]);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Lista"');
    expect(html).toContain(">uno</span>");
    expect(html).toContain(">dos</span>");
    expect(html).toContain('value="uno"');
    expect(html).toContain('aria-label="Subir elemento 2"');
    expect(html).toContain('aria-label="Bajar elemento 1"');
    expect(html).toContain('aria-label="Quitar elemento 1"');
    // max=2 alcanzado → añadir deshabilitado; subir del 1º y bajar del último también.
    expect(html).toMatch(/aria-label="Añadir elemento a Lista" disabled=""/);
    expect(html).toMatch(/aria-label="Subir elemento 1" disabled=""/);
    expect(html).toMatch(/aria-label="Bajar elemento 2" disabled=""/);
  });

  it("object: recursivo — renderiza los sub-campos con sus valores", () => {
    const field: VersoField = {
      type: "object",
      label: "Enlace",
      objectFields: {
        url: { type: "text", label: "URL" },
        blank: { type: "radio", label: "Nueva pestaña", options: [{ label: "Sí", value: true }, { label: "No", value: false }] },
      },
    };
    const html = render(field, { url: "/hola", blank: true });
    expect(html).toContain(">Enlace</legend>");
    expect(html).toContain(">URL</label>");
    expect(html).toContain('value="/hola"');
    expect(html).toContain('aria-label="Nueva pestaña"');
  });

  it("external: botón deshabilitado sin renderExternalPicker; resumen vía getItemSummary", () => {
    const field: VersoField = {
      type: "external",
      label: "Imagen",
      placeholder: "Sin selección",
      fetchList: async () => [],
      getItemSummary: (item) => `img:${(item as { id: number }).id}`,
    };
    const empty = render(field, undefined);
    expect(empty).toContain("Sin selección");
    expect(empty).toMatch(/Seleccionar…<\/button>/);
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Seleccionar…/);
    const withValue = render(field, { id: 7 }, { renderExternalPicker: () => null });
    expect(withValue).toContain("img:7");
    expect(withValue).not.toMatch(/<button[^>]*disabled=""[^>]*>Seleccionar…/);
    expect(withValue).toContain('aria-label="Quitar selección"');
  });

  it("custom: delega en field.render con {field,name,id,value,onChange} y el onChange llega al padre", () => {
    const onChange = vi.fn();
    const renderSpy = vi.fn((props: unknown) => {
      void props; // la aserción lee mock.calls; el param solo fija la aridad del spy
      return <div data-custom-field="">propio</div>;
    });
    const field: VersoField = { type: "custom", label: "Propio", render: renderSpy };
    const html = renderToStaticMarkup(
      <VersoFieldControl field={field} name="miCampo" value={5} onChange={onChange} />,
    );
    expect(html).toContain('data-custom-field=""');
    expect(renderSpy).toHaveBeenCalledTimes(1);
    const args = renderSpy.mock.calls[0][0] as {
      field: VersoField;
      name: string;
      id: string;
      value: unknown;
      onChange: (v: unknown) => void;
    };
    expect(args.field).toBe(field);
    expect(args.name).toBe("miCampo");
    expect(args.id).toBeTruthy();
    expect(args.value).toBe(5);
    args.onChange("nuevo");
    expect(onChange).toHaveBeenCalledWith("nuevo");
  });

  it("slot: aviso sin input — los hijos se editan en el lienzo", () => {
    const html = render({ type: "slot", label: "Contenido" }, []);
    expect(html).toContain("data-verso-slot-field");
    expect(html).toContain("se editan arrastrando en el lienzo");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
  });

  it("visible:false oculta el control por completo", () => {
    expect(render({ type: "text", label: "Oculto", visible: false }, "x")).toBe("");
  });
});

describe("fieldHelpers — mapeo interacción → valor de onChange", () => {
  it("optionIndexOf/optionValueAt: number, boolean, null y object", () => {
    const options = [
      { label: "n", value: 2 },
      { label: "b", value: false },
      { label: "nil", value: null },
      { label: "o", value: { a: 1 } },
    ] as const;
    expect(optionIndexOf(options, 2)).toBe(0);
    expect(optionIndexOf(options, false)).toBe(1);
    expect(optionIndexOf(options, null)).toBe(2);
    // Objeto por igualdad estructural (referencia distinta).
    expect(optionIndexOf(options, { a: 1 })).toBe(3);
    expect(optionIndexOf(options, "no-existe")).toBe(-1);

    expect(optionValueAt(options, "0")).toBe(2);
    expect(optionValueAt(options, "1")).toBe(false);
    expect(optionValueAt(options, "2")).toBe(null);
    expect(optionValueAt(options, "3")).toEqual({ a: 1 });
    expect(optionValueAt(options, "99")).toBeUndefined();
    expect(optionValueAt(options, "")).toBeUndefined();
  });

  it("parseNumberInput: '' → undefined, numérico → number, basura → undefined", () => {
    expect(parseNumberInput("")).toBeUndefined();
    expect(parseNumberInput("  ")).toBeUndefined();
    expect(parseNumberInput("42")).toBe(42);
    expect(parseNumberInput("-3.5")).toBe(-3.5);
    expect(parseNumberInput("abc")).toBeUndefined();
  });

  it("arrayAppend: clona defaultItemProps (nunca la misma referencia) y respeta max", () => {
    const defaults = { t: "seed", nested: { k: 1 } };
    const field: ArrayVersoField = { type: "array", arrayFields: {}, defaultItemProps: defaults, max: 2 };
    const one = arrayAppend(field, []);
    expect(one).toEqual([{ t: "seed", nested: { k: 1 } }]);
    expect(one[0]).not.toBe(defaults);
    expect(one[0].nested).not.toBe(defaults.nested);
    const two = arrayAppend(field, one);
    expect(two).toHaveLength(2);
    // max alcanzado → sin cambio (misma referencia).
    expect(arrayAppend(field, two)).toBe(two);
    expect(canAddItem(field, two)).toBe(false);
  });

  it("arrayRemoveAt respeta min; arrayMove reordena y clampa; arrayPatchItem no muta", () => {
    const field: ArrayVersoField = { type: "array", arrayFields: {}, min: 1 };
    const items = [{ t: "a" }, { t: "b" }, { t: "c" }];
    expect(arrayRemoveAt(field, items, 1)).toEqual([{ t: "a" }, { t: "c" }]);
    const single = [{ t: "solo" }];
    expect(arrayRemoveAt(field, single, 0)).toBe(single);
    expect(canRemoveItem(field, single)).toBe(false);

    expect(arrayMove(items, 0, 2)).toEqual([{ t: "b" }, { t: "c" }, { t: "a" }]);
    expect(arrayMove(items, 0, 5)).toBe(items);
    expect(arrayMove(items, -1, 0)).toBe(items);

    const patched = arrayPatchItem(items, 1, "t", "B");
    expect(patched[1]).toEqual({ t: "B" });
    expect(items[1]).toEqual({ t: "b" });
    expect(patched[0]).toBe(items[0]);
  });

  it("asArrayItems/asObjectValue/objectSet normalizan formas raras sin mutar", () => {
    expect(asArrayItems("no-array")).toEqual([]);
    expect(asObjectValue([1, 2])).toEqual({});
    expect(asObjectValue(null)).toEqual({});
    const base = { a: 1 };
    const next = objectSet(base, "b", 2);
    expect(next).toEqual({ a: 1, b: 2 });
    expect(base).toEqual({ a: 1 });
    expect(objectSet(undefined, "k", "v")).toEqual({ k: "v" });
  });
});
