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

function render(value: unknown, opts: { supportsWords?: boolean } = {}): string {
  return renderToStaticMarkup(
    <InteractionsControl
      value={value}
      onChange={noop}
      ixCtx={CTX}
      supportsWords={opts.supportsWords}
      onPreview={noop}
      onScrub={noop}
    />,
  );
}

/** Todos los `id` a los que apunta algún `for=`, y todos los `id` presentes. */
function labelTargets(html: string): { fors: string[]; ids: string[] } {
  return {
    fors: [...html.matchAll(/for="([^"]+)"/g)].map((m) => m[1]),
    ids: [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
  };
}

/** Elementos sin cierre: no abren subárbol. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

/**
 * El texto que un lector de pantalla LEERÍA dentro de un fragmento de markup.
 *
 * Quitar las etiquetas con `markup.replace(/<[^>]+>/g, "")` no vale para esto, por dos motivos:
 *
 *  1. una etiqueta sin cerrar sobrevive ENTERA al reemplazo (`'<i></i><script alert'` deja
 *     `'<script alert'`), así que el supuesto «texto» podía traer markup dentro — es el saneado
 *     incompleto que marca CodeQL con js/incomplete-multi-character-sanitization;
 *  2. contaba el contenido de los subárboles `aria-hidden="true"` — y eso es justo lo que NO se
 *     lee: los iconos `MSym` son un `<span aria-hidden="true">` cuyo texto es el nombre de la
 *     ligadura ("play_arrow"), de modo que un botón de solo icono y sin `aria-label` pasaba por
 *     «tiene nombre accesible» cuando su nombre es la cadena vacía.
 *
 * Se recorre el markup carácter a carácter: un `<` no llega nunca a la salida, así que no hay
 * forma de reconstruir una etiqueta con los restos.
 */
function accessibleText(markup: string): string {
  let out = "";
  let hidden = false; // dentro de un subárbol aria-hidden
  let depth = 0; // elementos abiertos dentro de ese subárbol
  let i = 0;
  while (i < markup.length) {
    if (markup[i] !== "<") {
      if (!hidden) out += markup[i];
      i += 1;
      continue;
    }
    const close = markup.indexOf(">", i);
    if (close === -1) break; // etiqueta a medio escribir: ahí ya no queda texto que leer
    const tag = markup.slice(i + 1, close);
    i = close + 1;
    const isEnd = tag.startsWith("/");
    const name = (isEnd ? tag.slice(1) : tag).trim().split(/[\s/]/)[0].toLowerCase();
    const opensSubtree = !tag.endsWith("/") && !VOID_TAGS.has(name);
    if (hidden) {
      if (isEnd) {
        if (depth === 0) hidden = false;
        else depth -= 1;
      } else if (opensSubtree) depth += 1;
    } else if (!isEnd && opensSubtree && /\saria-hidden="true"/.test(tag)) {
      hidden = true;
      depth = 0;
    }
  }
  // `&nbsp;` y sus formas numéricas son espacio: un botón que solo lleva eso no tiene nombre.
  return out.replace(/&(?:nbsp|#160|#xa0);/gi, " ").replace(/\s+/g, " ").trim();
}

/** Un botón tiene nombre si lo dice `aria-label` (no vacío) o si algo se lee dentro. */
function hasAccessibleName(attrs: string, inner: string): boolean {
  return /\saria-label="[^"]+"/.test(attrs) || accessibleText(inner).length > 0;
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
      expect(hasAccessibleName(attrs, inner), `botón sin nombre accesible: <button${attrs}>`).toBe(
        true,
      );
    }
  });
});

/**
 * El gate de arriba vale lo que valga `accessibleText`: si el ayudante contase de más, diría que
 * todos los botones tienen nombre pase lo que pase. Estos son sus controles negativos.
 */
describe("accessibleText — qué se lee de verdad dentro de un botón", () => {
  it("un botón de solo icono NO tiene nombre: `aria-hidden` no se lee", () => {
    // Es el markup exacto de MSym: el texto del span es el nombre de la ligadura, no una palabra.
    const soloIcono = '<span aria-hidden="true" class="msym">play_arrow</span>';
    expect(accessibleText(soloIcono)).toBe("");
    expect(hasAccessibleName("", soloIcono)).toBe(false);
    // …y con `aria-label` sí lo tiene, que es como está resuelto en el panel.
    expect(hasAccessibleName(' aria-label="Probar"', soloIcono)).toBe(true);
    // El texto que acompaña al icono sigue contando.
    expect(accessibleText(`${soloIcono} Probar`)).toBe("Probar");
  });

  it("ninguna etiqueta se cuela en el texto, ni siquiera a medio cerrar", () => {
    // Una sola pasada de `replace(/<[^>]+>/g, "")` deja aquí `<script alert` intacto.
    expect(accessibleText('<i class="x"></i><script alert')).toBe("");
    expect(accessibleText("<b>Quitar</b>")).toBe("Quitar");
    expect(accessibleText("<b>Qui</b>tar")).toBe("Quitar"); // el marcado en línea no parte la palabra
    expect(accessibleText("<span>Añadir</span> <span>paso</span>")).toBe("Añadir paso");
  });

  it("un espacio duro no es un nombre", () => {
    expect(accessibleText("&nbsp;")).toBe("");
    expect(accessibleText("<span>&#160;</span>")).toBe("");
    expect(hasAccessibleName(' aria-label=""', "&nbsp;")).toBe(false);
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

  it("«Las palabras» se ofrece SOLO en bloques que declaran `ixText`, y nunca se pierde si el dato ya lo trae", () => {
    // Ofrecer un objetivo en un bloque cuyo render no emite los spans sería una opción que miente:
    // el compilador escribiría reglas contra un selector que no existe en la página.
    expect(render(defaultIxSpec())).not.toContain("Las palabras");
    // En Heading/Quote (que sí los emiten) el panel lo ofrece.
    expect(render(defaultIxSpec(), { supportsWords: true })).toContain("Las palabras");
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

/**
 * LA CURVA PROPIA (bez). El selector de curvas gana el sentinel «Curva propia…»; con `bez` en el
 * paso, el dibujo (IxCurveEditor) se monta debajo y edita el mismo valor. Qué se ESCRIBE al elegir
 * cada cosa está en ixPanelModel.test.ts (setStepBez/setStepEase); aquí, el markup y sus nombres.
 */
describe("InteractionsControl — la curva propia", () => {
  const conBez = {
    v: 1,
    trigger: { on: "view", once: true },
    tracks: [
      {
        target: { kind: "self" },
        steps: [
          { at: 0, set: { opacity: 0 }, bez: [0.16, 1, 0.3, 1] },
          { at: 100, set: { opacity: 1 } },
        ],
      },
    ],
  };

  it("el selector lista las curvas físicas y «Curva propia…»", () => {
    const html = render(defaultIxSpec());
    expect(html).toContain("Rebote");
    expect(html).toContain("Elástico");
    expect(html).toContain("Curva propia…");
    // …pero sin `bez` el dibujo no se monta.
    expect(html).not.toContain("Punto de control");
  });

  it("con `bez` en el paso se monta el dibujo: tiradores enfocables con nombre y los 4 números", () => {
    const html = render(conBez);
    // Dos tiradores, enfocables con teclado, con su posición en el nombre accesible.
    expect(html).toContain('aria-label="Punto de control 1 (x 0.16, y 1.00)"');
    expect(html).toContain('aria-label="Punto de control 2 (x 0.30, y 1.00)"');
    expect((html.match(/tabindex="0"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // La región que anuncia los movimientos de flecha.
    expect(html).toContain('aria-live="polite"');
    // El camino canónico: los cuatro campos numéricos, etiquetados por id.
    const { fors, ids } = labelTargets(html);
    for (const key of ["X1", "Y1", "X2", "Y2"]) expect(html).toContain(`>${key}</label>`);
    for (const target of fors) expect(ids, `label sin destino: ${target}`).toContain(target);
    // Y el selector enseña el sentinel, no un nombre.
    expect(html).toContain("Curva propia…");
  });

  it("en solo lectura (preajuste enlazado) el dibujo NO se monta: cada arrastre escribiría", () => {
    const html = render({ v: 1, preset: "aparecer-tarjetas" });
    expect(html).not.toContain("Punto de control");
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

/**
 * EL SCRUBBER (§6.3). Su fidelidad —que mueva el estado real y no una imitación— se verifica en
 * `lib/verso/interactions/__tests__/ix-scrubber.test.ts` sobre el IR. Aquí se fija lo que le toca al
 * PANEL: que exista, que sea operable con teclado y que se pueda SOLTAR sin ratón.
 */
describe("InteractionsControl — el scrubber", () => {
  it("no aparece sin interacción: no hay nada que recorrer", () => {
    expect(render(undefined)).not.toContain('type="range"');
  });

  it("con interacción hay un deslizador NATIVO (flechas, Inicio/Fin) con su etiqueta y su unidad", () => {
    const html = render(defaultIxSpec());
    expect(html).toContain('type="range"');
    expect(html).toContain("Recorrer a mano");
    // Un `slider` nativo anuncia su valor; `aria-valuetext` le pone la unidad para que no se lea un
    // número suelto. No se añade una región `aria-live` con el porcentaje: duplicaría el anuncio en
    // cada pulsación de flecha.
    expect(html).toContain('aria-valuetext="0 %"');
    const range = html.match(/<input[^>]*type="range"[^>]*>/)![0];
    expect(range).toContain('min="0"');
    expect(range).toContain('max="100"');
    // Y su etiqueta apunta a él por id, como el resto del panel.
    const rangeId = range.match(/\sid="([^"]+)"/)![1];
    expect(html).toContain(`for="${rangeId}"`);
  });

  it("se ARMA y se SUELTA con un botón: con teclado no existe «soltar el ratón»", () => {
    const html = render(defaultIxSpec());
    // Un botón conmutador de verdad (aria-pressed), no un div con onMouseUp.
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>/);
    expect(html).toContain("Recorrer");
    // Y el deslizador nace deshabilitado: hasta que alguien arma, el lienzo lo manda el CSS.
    expect(html).toMatch(/<input[^>]*type="range"[^>]*disabled/);
  });

  it("explica qué hace, y por qué importa en las interacciones de scroll", () => {
    const scrub = {
      v: 1,
      trigger: { on: "scrub" },
      tracks: [
        {
          target: { kind: "self" },
          steps: [
            { at: 0, set: { y: 20 } },
            { at: 100, set: { y: -20 } },
          ],
        },
      ],
    };
    expect(render(scrub)).toContain("avanza con el scroll");
    expect(render(defaultIxSpec())).toContain("pararte en cualquier punto");
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
