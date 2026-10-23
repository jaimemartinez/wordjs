/**
 * Ajustes → Interacciones: el FORMULARIO de un preajuste — markup y accesibilidad.
 *
 * ENTORNO node sin jsdom (el proyecto no lo tiene y las dependencias nuevas están vetadas), así que
 * se verifica sobre el markup de `renderToStaticMarkup`, que es donde vive la accesibilidad
 * ESTRUCTURAL: la etiqueta asociada por id, el `fieldset/legend` de los pasos, el nombre accesible
 * de cada botón.
 *
 * ⚠ EL TEST QUE MÁS VALE ES EL PRIMERO, y existe porque el fallo OCURRIÓ: la primera versión de esta
 * pantalla usaba un `Select` que no aceptaba `id`. Las cinco etiquetas de los desplegables
 * apuntaban a ids inexistentes, así que un lector de pantalla anunciaba «Al entrar en pantalla,
 * botón» sin decir de qué. El `Select` del kit (components/ui) toma el `id` y ata la etiqueta a su
 * botón; este test sigue vigilando que ninguna etiqueta apunte al vacío.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultIxSpec } from "@/components/verso/editor/ixPanelModel";
import type { IxSpec } from "@/lib/verso/interactions";
import { I18nProvider } from "@/contexts/I18nContext";
import PresetEditor from "../PresetEditor";

const noop = () => undefined;

function render(draft: IxSpec = defaultIxSpec(), extra: { id?: string | null; error?: string | null } = {}) {
  return renderToStaticMarkup(
    <I18nProvider>
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
    />
    </I18nProvider>,
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

  it("los desplegables son el `Select` del kit, con la etiqueta atada a su botón", () => {
    const html = render();
    // Cuándo, Qué se mueve, Repetición, Curva del paso 0, Añadir propiedad ×2.
    const triggers = html.match(/<button id="[^"]+" type="button" aria-haspopup="listbox"/g) ?? [];
    expect(triggers.length).toBeGreaterThanOrEqual(5);
    for (const id of ["ixp-trigger", "ixp-target", "ixp-once"]) {
      expect(html).toContain(`<button id="${id}" type="button" aria-haspopup="listbox"`);
      expect(html).toContain(`for="${id}"`);
    }
  });

  it("todo lo interactivo es nativo y enfocable; ningún div con onClick", () => {
    const html = render();
    expect(html).toMatch(/<button/);
    expect(html).toMatch(/<input/);
    expect(html).toMatch(/aria-haspopup="listbox"/);
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

/**
 * DISPARADOR `event` (P11), SUAVIZADO DEL SCRUB (P10) Y TRAZO SVG (P12) — el espejo del panel del
 * bloque. Qué ESCRIBE cada control está en ixPanelModel.test.ts (los mismos escritores puros);
 * aquí, que el formulario los ofrezca, con la etiqueta por id y los textos de honestidad.
 */
describe("PresetEditor — evento a medida, suavizado del scrub y trazo SVG", () => {
  it("«Cuándo» ofrece «Con un evento a medida»", () => {
    // The kit's list is portalled and drawn only when open: the chosen option is what the trigger shows.
    const evento: IxSpec = { ...defaultIxSpec(), trigger: { on: "event", name: "abrir-menu" } };
    expect(render(evento)).toMatch(/<button id="ixp-trigger"[^>]*>(?:(?!<\/button>)[\s\S])*Con un evento a medida/);
  });

  it("con `event`: nombre etiquetado por id, prefijo real, regla del slug y conmutación", () => {
    const evento: IxSpec = { ...defaultIxSpec(), trigger: { on: "event", name: "abrir-menu" } };
    const html = render(evento);
    expect(html).toContain('for="ixp-event-name"');
    expect(html).toMatch(/<input[^>]*id="ixp-event-name"[^>]*value="abrir-menu"/);
    expect(html).toContain("wjs:ix:");
    expect(html).toContain("minúsculas, números y guiones");
    expect(html).toContain("Cada evento alterna (entra/sale)");
  });

  it("la conmutación refleja el dato", () => {
    const base: IxSpec = { ...defaultIxSpec(), trigger: { on: "event", name: "abrir-menu" } };
    expect(render(base)).toMatch(/<input(?![^>]*checked)[^>]*type="checkbox"[^>]*>(?:(?!<input)[\s\S])*?Cada evento alterna/);
    const conToggle: IxSpec = {
      ...defaultIxSpec(),
      trigger: { on: "event", name: "abrir-menu", toggle: true },
    };
    expect(render(conToggle)).toMatch(/<input(?=[^>]*checked="")[^>]*type="checkbox"[^>]*>(?:(?!<input)[\s\S])*?Cada evento alterna/);
  });

  it("con `scrub` se ofrece el suavizado (P10) con su nota de honestidad", () => {
    const scrub: IxSpec = { ...defaultIxSpec(), trigger: { on: "scrub", smooth: 250 } };
    const html = render(scrub);
    expect(html).toContain('for="ixp-scrub-smooth"');
    expect(html).toMatch(/<input[^>]*id="ixp-scrub-smooth"[^>]*value="250"/);
    expect(html).toContain("0 = sin suavizado");
    expect(html).toContain("camino puro de CSS");
  });

  it("«El trazo SVG» se ofrece y, elegido, la ayuda dice su contrato", () => {
    const svg: IxSpec = {
      ...defaultIxSpec(),
      tracks: [
        {
          target: { kind: "svg" },
          steps: [
            { at: 0, set: { draw: 0 } },
            { at: 100, set: { draw: 100 } },
          ],
        },
      ],
    };
    const html = render(svg);
    // Chosen, the kit Select's trigger shows it (its list is drawn only when open).
    expect(html).toMatch(/<button id="ixp-target"[^>]*>(?:(?!<\/button>)[\s\S])*El trazo SVG/);
    expect(html).toContain("wjs-ixd");
    expect(html).toContain("pathLength");
    expect(html).toContain("no se anima nada");
  });

  it("el aviso de «Las palabras» dice que en otros bloques no mueve nada", () => {
    const words: IxSpec = {
      ...defaultIxSpec(),
      tracks: [{ ...defaultIxSpec().tracks![0], target: { kind: "words" } }],
    };
    expect(render(words)).toContain("En cualquier otro bloque este objetivo no mueve nada");
  });
});
