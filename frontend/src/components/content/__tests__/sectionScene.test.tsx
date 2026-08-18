/**
 * C5 — la ESCENA FIJA: el "pin" honesto.
 *
 * Las librerías fijan un elemento inyectando un espaciador y REESCRIBIENDO la maquetación al hacer
 * scroll. Aquí la sección reserva su altura por adelantado y su escenario se queda quieto con
 * `position: sticky`: nada muta en caliente, así que el desplazamiento acumulado de diseño es cero
 * por construcción y no hay una línea de JS.
 *
 * Lo que se fija aquí es el CONTRATO del marcado y el de la hoja; el movimiento que lee la escena
 * vive en el compilador (`ix-triggers.test.ts`) y en el fallback (`ix-runtime.test.ts`).
 *
 * Entorno node (sin jsdom, como el resto de `content/__tests__`): markup por renderToStaticMarkup.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { SectionBlock } from "../blocks";

const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
        React.createElement(SectionBlock, {
            ...props,
            slot: () => React.createElement("p", null, "contenido"),
        } as never),
    );

const CSS = fs.readFileSync(
    path.resolve(process.cwd(), "../backend/public/css/wordjs-ui.css"),
    "utf-8",
);
/** El fichero lleva comentarios que hablan de lo mismo que se busca: se quitan antes de afirmar. */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("escena fija — el marcado", () => {
    it("SIN escena, el HTML es el de siempre: ni clase, ni envoltorio, ni variable", () => {
        const html = render({ maxWidth: "1280px" });
        expect(html).not.toContain("section--scene");
        expect(html).not.toContain("section__stage");
        expect(html).not.toContain("--wjs-section-scene");
        // El contrato duro del ciclo: una capacidad de movimiento no cambia el HTML de quien no la usa.
        expect(html).toBe(render({ maxWidth: "1280px", stick: "" }));
    });

    it("CON escena aparecen la clase, el escenario y las pantallas que dura", () => {
        const html = render({ stick: "3" });
        expect(html).toContain("wjs-block-section--scene");
        expect(html).toContain("wjs-block-section__stage");
        expect(html).toContain("--wjs-section-scene:3");
        // El escenario ENVUELVE al inner de siempre: el contenido no cambia de sitio en el árbol.
        expect(html.indexOf("section__stage")).toBeLessThan(html.indexOf("section__inner"));
    });

    it("un valor fuera de la lista cerrada NO llega a la hoja (entra en un calc())", () => {
        for (const hostile of ["9999", "2; }", "calc(100vh*99)", "-1", true, 3]) {
            const html = render({ stick: hostile });
            expect(html).not.toContain("section--scene");
            expect(html).not.toContain("--wjs-section-scene");
        }
    });
});

describe("escena fija — la hoja servida", () => {
    it("la altura se RESERVA en la sección y el escenario es sticky (cero CLS, cero JS)", () => {
        expect(CSS_RULES).toMatch(/\.wjs-block-section--scene[^{]*\{[^}]*min-height:\s*calc\(100vh \* var\(--wjs-section-scene/);
        expect(CSS_RULES).toMatch(/\.wjs-block-section__stage[^{]*\{[^}]*position:\s*sticky/);
    });

    it("`100svh` acompaña a `100vh`: en móvil la barra del navegador cambia el alto de la ventana", () => {
        const scene = /\.wjs-block-section--scene[^{]*\{([^}]*)\}/.exec(CSS_RULES)?.[1] ?? "";
        expect(scene).toContain("100svh");
        expect(scene).toContain("100vh"); // reserva para el motor que no entienda svh
    });

    it("la sección declara la timeline CON NOMBRE que el compilador emite", () => {
        expect(CSS_RULES).toContain("view-timeline-name: --wjs-ix-scene");
        // Detrás de un @supports: un motor que no las tenga no debe ver la declaración.
        expect(CSS_RULES).toMatch(/@supports \(view-timeline-name:[^)]*\)\s*\{[\s\S]*?--wjs-ix-scene/);
    });
});
