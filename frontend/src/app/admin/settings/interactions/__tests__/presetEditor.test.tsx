/**
 * Ajustes → Interacciones: el FORMULARIO de un preajuste — markup y accesibilidad.
 *
 * ENTORNO node sin jsdom (el proyecto no lo tiene y las dependencias nuevas están vetadas), así que
 * se verifica sobre el markup de `renderToStaticMarkup`, que es donde vive la accesibilidad
 * ESTRUCTURAL: la etiqueta asociada por id, el `fieldset/legend` de los pasos, el nombre accesible
 * de cada botón.
 *
 * ⚠ EL TEST QUE MÁS VALE ES EL PRIMERO, y existe porque el fallo OCURRIÓ: la primera versión de esta
 * pantalla usaba el `Select` de `@/components/ui`, que es un botón con una lista portaleada y no
 * acepta `id`. Las cinco etiquetas de los desplegables apuntaban a ids inexistentes, así que un
 * lector de pantalla anunciaba «Al entrar en pantalla, botón» sin decir de qué. Se vio leyendo el
 * DOM en el navegador. Este test lo habría cazado antes.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultIxSpec } from "@/components/verso/editor/ixPanelModel";
import type { IxSpec } from "@/lib/verso/interactions";
import PresetEditor from "../PresetEditor";

const noop = () => undefined;

function render(draft: IxSpec = defaultIxSpec(), extra: { id?: string | null; error?: string | null } = {}) {
  return renderToStaticMarkup(
    <PresetEditor
      draft={draft}
      name="Titular en cascada"
      id={extra.id === undefined ? "titular-en-cascada" : extra.id}
      error={extra.error ?? null}
      saving={false}
      onName={noop}
      onDraft={noop}
      onSave={noop}
      onCancel={noop}
    />,
  );
}

/** Todos los `for=` y todos los `id=` del markup. */
function ids(html: string) {
  return {
    fors: [...html.matchAll(/for="([^"]+)"/g)].map((m) => m[1]),
    present: new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])),
  };
}

describe("PresetEditor — cada control tiene nombre accesible", () => {
  it("NINGUNA etiqueta apunta a un id que no existe", () => {
    const html = render();
    const { fors, present } = ids(html);
    expect(fors.length).toBeGreaterThan(5);
    for (const target of fors) {
      expect(present.has(target), `<label for="${target}"> no apunta a ningún elemento`).toBe(true);
    }
  });

  it("los desplegables son `select` NATIVOS (etiquetables y navegables con teclado)", () => {
    const html = render();
    // Cuándo, Qué se mueve, Repetición, Curva del paso 0, Añadir propiedad ×2.
    expect((html.match(/<select /g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('id="ixp-trigger"');
    expect(html).toContain('id="ixp-target"');
    expect(html).toContain('id="ixp-once"');
  });

  it("todo lo interactivo es nativo y enfocable; ningún div con onClick", () => {
    const html = render();
    expect(html).toMatch(/<button/);
    expect(html).toMatch(/<input/);
    expect(html).toMatch(/<select/);
    expect(html).not.toMatch(/<div[^>]*role="button"/);
    expect(html).not.toMatch(/tabindex="-1"/i);
  });

  it("los pasos son una lista dentro de un fieldset con su leyenda", () => {
    const html = render();
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).toContain("Pasos (2)");
    expect(html).toContain("<ol");
  });

  it("el resumen de lo que hay puesto se anuncia como estado", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain("Interacción:");
  });

  it("un error de guardado se anuncia como alerta, no como texto suelto", () => {
    const html = render(defaultIxSpec(), { error: "El preajuste necesita un nombre." });
    expect(html).toMatch(/role="alert"[^>]*>[^<]*El preajuste necesita un nombre\./);
  });
});

describe("PresetEditor — lo que distingue un alta de una edición", () => {
  it("editando se enseña el identificador y se explica que NO cambia", () => {
    const html = render();
    expect(html).toContain("titular-en-cascada");
    expect(html).toContain("no cambia");
    expect(html).toContain("Guardar cambios");
  });

  it("en un alta no hay identificador que enseñar todavía", () => {
    const html = render(defaultIxSpec(), { id: null });
    expect(html).toContain("Crear preajuste");
    expect(html).not.toContain("Identificador:");
  });

  it("el aviso del split por palabras solo sale cuando el objetivo son las palabras", () => {
    expect(render()).not.toContain("Las palabras» solo mueve");
    const words: IxSpec = {
      ...defaultIxSpec(),
      tracks: [{ ...defaultIxSpec().tracks![0], target: { kind: "words" } }],
    };
    expect(render(words)).toContain("Las palabras» solo mueve");
  });
});
