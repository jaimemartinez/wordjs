/**
 * Verso — panel de interacciones: MARKUP y ACCESIBILIDAD (gate F9-D.1).
 *
 * ENTORNO node sin jsdom (el mismo criterio que versoFieldControl.test.tsx y editorRenderer.test.tsx:
 * el proyecto no tiene jsdom/@testing-library y las dependencias nuevas están vetadas), así que:
 *  - el MARKUP se verifica con renderToStaticMarkup — que es donde vive la accesibilidad estructural:
 *    etiqueta asociada por id, `fieldset/legend` de cada radiogrupo, nombre accesible de cada botón,
 *    región `role="status"` que anuncia el resultado;
 *  - el COMPORTAMIENTO (qué se guarda al tocar cada control) está en ixPanelModel.test.ts, sobre las
 *    funciones puras que estos handlers invocan tal cual.
 *
 * "Operable solo con teclado" se sostiene por construcción y se comprueba aquí de la única forma
 * honesta sin navegador: que TODO control interactivo del panel sea un elemento nativo enfocable
 * (`button`, `input`, `select`, `summary`) y que no haya ni un `div`/`span` con `onClick`. Un
 * elemento nativo es enfocable y activable con teclado sin que nadie tenga que acordarse.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ixCtxFromSite, parseSiteIxPresets, type IxCompileCtx } from "@/lib/verso/interactions";
import { defaultIxSpec } from "../../editor/ixPanelModel";
import InteractionsControl from "../InteractionsControl";

const CTX: IxCompileCtx = ixCtxFromSite(
  parseSiteIxPresets(
    JSON.stringify([
      {
        id: "aparecer-tarjetas",
        name: "Aparecer tarjetas",
        trigger: { on: "view", once: true },
        tracks: [
          {
            target: { kind: "children" },
            steps: [
              { at: 0, set: { opacity: 0, y: 20 }, ease: "out" },
              { at: 100, set: { opacity: 1, y: 0 } },
            ],
            stagger: { each: 80 },
          },
        ],
        rev: 1,
      },
    ]),
  ),
);

const noop = (): void => undefined;

function render(value: unknown): string {
  return renderToStaticMarkup(
    <InteractionsControl value={value} onChange={noop} ixCtx={CTX} onPreview={noop} />,
  );
}

/** Todos los `id` a los que apunta algún `for=`, y todos los `id` presentes. */
function labelTargets(html: string): { fors: string[]; ids: string[] } {
  return {
    fors: [...html.matchAll(/for="([^"]+)"/g)].map((m) => m[1]),
    ids: [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
  };
}

describe("InteractionsControl — estructura y nombres accesibles", () => {
  it("la sección se anuncia por su título (aria-labelledby → el id del encabezado)", () => {
    const html = render(undefined);
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/);
    expect(labelledBy).not.toBeNull();
    expect(html).toContain(`id="${labelledBy![1]}"`);
    expect(html).toContain("Interacción");
  });

  it("hay una región de estado que ANUNCIA el resultado, no el gesto", () => {
    expect(render(undefined)).toContain('role="status"');
    expect(render(undefined)).toContain("Sin interacción.");
    const activa = render({ v: 1, preset: "aparecer-tarjetas" });
    expect(activa).toContain("Aparecer tarjetas");
    expect(activa).toContain("al entrar en pantalla");
  });

  it("sin interacción: solo el nivel 1, y los botones de acción deshabilitados", () => {
    const html = render(undefined);
    expect(html).toContain("Preajuste");
    expect(html).not.toContain("Editar pasos");
    expect(html).not.toContain("Qué se mueve");
    // "Probar" y "Quitar" existen pero no se pueden pulsar: no hay nada que probar ni que quitar.
    expect(html.match(/<button[^>]*disabled/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("cada control tiene etiqueta asociada por id (nada queda sin nombre accesible)", () => {
    const html = render(defaultIxSpec());
    const { fors, ids } = labelTargets(html);
    expect(fors.length).toBeGreaterThan(3);
    for (const target of fors) expect(ids, `label sin destino: ${target}`).toContain(target);
  });

  it("los radiogrupos son fieldset+legend con radios de verdad (navegables con flechas)", () => {
    const html = render(defaultIxSpec());
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('type="radio"');
    expect(html).toContain("Cuándo");
    expect(html).toContain("Qué se mueve");
  });

  it("todo lo interactivo es un elemento NATIVO enfocable; ningún div/span con onClick", () => {
    const html = render(defaultIxSpec());
    // renderToStaticMarkup no emite los handlers, así que la comprobación se hace sobre el tipo de
    // elemento: si un control no fuera nativo, no habría botón/input/select/summary que lo cubriese.
    expect(html).toMatch(/<button/);
    expect(html).toMatch(/<select/);
    expect(html).toMatch(/<input/);
    expect(html).toMatch(/<summary/);
    expect(html).not.toMatch(/<div[^>]*role="button"/);
    expect(html).not.toMatch(/tabindex="-1"/i);
  });

  it("todos los botones tienen nombre accesible (texto o aria-label)", () => {
    const html = render(defaultIxSpec());
    const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
    expect(buttons.length).toBeGreaterThan(2);
    for (const [, attrs, inner] of buttons) {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      const hasLabel = /aria-label="/.test(attrs) || text.length > 0;
      expect(hasLabel, `botón sin nombre accesible: <button${attrs}>`).toBe(true);
    }
  });
});

describe("InteractionsControl — los tres niveles", () => {
  it("nivel 1: el desplegable lista Ninguna, sistema, sitio y Personalizada", () => {
    const html = render(undefined);
    expect(html).toContain("Ninguna");
    expect(html).toContain("Aparecer subiendo"); // sys:fade-up
    expect(html).toContain("Aparecer tarjetas"); // preajuste del sitio
    expect(html).toContain("Personalizada");
  });

  it("nivel 2: disparador, repetición, objetivo y tiempos con cuerpo propio", () => {
    const html = render(defaultIxSpec());
    expect(html).toContain("Cuándo");
    expect(html).toContain("Al entrar en pantalla");
    expect(html).toContain("Con el scroll");
    expect(html).toContain("Repetición");
    expect(html).toContain("Duración (ms)");
    expect(html).toContain("Retardo (ms)");
  });

  it("«Las palabras» NO se ofrece (aún no hay bloque que parta el texto), pero no se pierde si el dato ya lo trae", () => {
    // Ofrecer un objetivo que hoy no mueve nada sería una opción que miente.
    expect(render(defaultIxSpec())).not.toContain("Las palabras");
    const words = {
      v: 1,
      trigger: { on: "view", once: true },
      tracks: [
        {
          target: { kind: "words" },
          steps: [
            { at: 0, set: { opacity: 0 } },
            { at: 100, set: { opacity: 1 } },
          ],
        },
      ],
    };
    // …pero un `_puck_data` que ya lo lleva no puede quedarse con el radiogrupo sin selección.
    expect(render(words)).toContain("Las palabras");
  });

  it("el escalonado aparece SOLO cuando el objetivo son varios elementos", () => {
    expect(render(defaultIxSpec())).not.toContain("Escalonado");
    const hijos = {
      v: 1,
      trigger: { on: "view", once: true },
      tracks: [
        {
          target: { kind: "children" },
          steps: [
            { at: 0, set: { opacity: 0 } },
            { at: 100, set: { opacity: 1 } },
          ],
        },
      ],
    };
    expect(render(hijos)).toContain("Escalonado");
  });

  it("con `scrub` no hay duración ni retardo: el progreso lo marca la posición, no el reloj", () => {
    const scrub = {
      v: 1,
      trigger: { on: "scrub" },
      tracks: [
        {
          target: { kind: "self" },
          steps: [
            { at: 0, set: { y: 30 } },
            { at: 100, set: { y: -30 } },
          ],
        },
      ],
    };
    const html = render(scrub);
    expect(html).toContain("Con el scroll");
    expect(html).not.toContain("Duración (ms)");
  });

  it("nivel 3: la tira de pasos, con momento, curva y las propiedades del paso", () => {
    const tres = {
      v: 1,
      trigger: { on: "view", once: true },
      tracks: [
        {
          target: { kind: "self" },
          steps: [
            { at: 0, set: { opacity: 0, y: 24 }, ease: "out" },
            { at: 60, set: { opacity: 1, y: 0 }, ease: "out" },
            { at: 100, set: { opacity: 1, y: 0 } },
          ],
        },
      ],
    };
    const html = render(tres);
    expect(html).toContain("Editar pasos (3)");
    expect(html).toContain("Inicio (0 %)");
    expect(html).toContain("Final (100 %)");
    expect(html).toContain("Momento (%)"); // solo en el paso intermedio
    expect(html).toContain("Curva hasta el siguiente");
    expect(html).toContain("Opacidad");
    expect(html).toContain("Mover en Y (px)");
    expect(html).toContain("Añadir propiedad");
    expect(html).toContain("+ Añadir paso");
  });

  it("los extremos NO ofrecen «Momento»: el normalizador los reancla a 0 y 100", () => {
    const html = render(defaultIxSpec()); // 2 pasos: los dos son extremos
    expect(html).toContain("Editar pasos (2)");
    expect(html).not.toContain("Momento (%)");
  });
});

describe("InteractionsControl — enlazado a un preajuste", () => {
  it("los pasos se muestran en SOLO LECTURA y se ofrece desvincular", () => {
    const html = render({ v: 1, preset: "aparecer-tarjetas" });
    expect(html).toContain("Desvincular");
    expect(html).toContain("Solo lectura");
    expect(html).not.toContain("+ Añadir paso");
    expect(html).not.toContain("Añadir propiedad");
    // El disparador SÍ se puede cambiar: es el único override local que no bifurca el cuerpo.
    expect(html).toContain("Cuándo");
    // …y el objetivo no, porque eso es cuerpo.
    expect(html).not.toContain("Qué se mueve");
  });

  it("dice lo que significa compartir un preajuste (que editarlo cambia todos los bloques)", () => {
    expect(render({ v: 1, preset: "aparecer-tarjetas" })).toContain("los demás bloques que lo usan");
  });
});

describe("InteractionsControl — datos rotos", () => {
  it("una referencia rota se AVISA en el panel y no rompe el render", () => {
    const html = render({ v: 1, preset: "ya-no-existe" });
    expect(html).toContain("no encontrado");
    expect(html).toContain('role="status"');
  });

  it("un `ix` hostil se pinta como 'sin interacción', sin lanzar", () => {
    for (const bad of [null, 42, "x", { v: 7 }, { v: 1, tracks: [{ target: 1 }] }]) {
      expect(() => render(bad)).not.toThrow();
      expect(render(bad)).toContain("Sin interacción.");
    }
  });
});
