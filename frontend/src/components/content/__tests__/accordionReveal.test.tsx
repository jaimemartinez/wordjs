/**
 * C2 — el acordeón se REVELA en vez de aparecer de golpe.
 *
 * El defecto que esto cierra: el panel se montaba y desmontaba (`{open && <div>}`), así que no había
 * ningún elemento al que aplicarle una transición — el bloque interactivo más común de cualquier
 * sitio abría y cerraba con un salto seco, y ninguna hoja de estilos podía arreglarlo.
 *
 * Aquí se fija el CONTRATO que hace posible la transición, no la animación en sí (eso es CSS y vive
 * en wordjs-ui.css, con su propio pin abajo):
 *   1. el panel está SIEMPRE en el HTML — también el cerrado, para que el contenido siga siendo
 *      rastreable y exista algo que animar;
 *   2. lleva su envoltorio interior, que es lo que la técnica de grid necesita para recortar;
 *   3. cabecera y panel están atados por `aria-controls`/`id`, que solo tiene sentido ahora que el
 *      panel no desaparece;
 *   4. el estado abierto se comunica por `aria-expanded` y por la clase `is-open` del ítem — que es
 *      el selector del que cuelga toda la revelación.
 *
 * Entorno node (sin jsdom, como el resto de `content/__tests__`): markup por renderToStaticMarkup.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import AccordionBlock from "../AccordionBlock";

const ITEMS = [
    { title: "Primera", content: "Contenido uno" },
    { title: "Segunda", content: "Contenido dos" },
];

const html = () => renderToStaticMarkup(<AccordionBlock items={ITEMS} />);

describe("AccordionBlock — el panel cerrado EXISTE", () => {
    it("renderiza los dos paneles, no solo el abierto", () => {
        const out = html();
        expect(out).toContain("Contenido uno");
        // El segundo está CERRADO y aun así en el HTML: sin él no hay nada que animar (ni que
        // rastrear). Este es el defecto exacto que cerró C2.
        expect(out).toContain("Contenido dos");
        expect(out.match(/wjs-block-accordion__panel[^-]/g)?.length).toBe(2);
    });

    it("cada panel trae recorte Y caja de relleno — dos capas, no una", () => {
        const out = html();
        expect(out.match(/wjs-block-accordion__panel-inner/g)?.length).toBe(2);
        // La segunda capa NO es adorno: el relleno no colapsa con `min-height:0`, así que en una
        // sola capa el panel cerrado medía 32px en vez de cero (medido en el navegador).
        expect(out.match(/wjs-block-accordion__panel-body/g)?.length).toBe(2);
    });

    it("cabecera y panel quedan atados por aria-controls/id", () => {
        const out = html();
        const ids = [...out.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
        const controls = [...out.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
        expect(controls).toHaveLength(2);
        for (const c of controls) expect(ids).toContain(c);
    });

    it("el estado abierto viaja por aria-expanded y por la clase del ítem", () => {
        const out = html();
        expect(out).toContain('aria-expanded="true"');
        expect(out).toContain('aria-expanded="false"');
        expect(out.match(/is-open/g)?.length).toBe(1);
    });
});

describe("wordjs-ui.css — la revelación, y sus dos garantías", () => {
    const css = fs.readFileSync(
        path.join(process.cwd(), "..", "backend", "public", "css", "wordjs-ui.css"),
        "utf8",
    );

    it("el pliegue se hace con grid 0fr→1fr (los tres motores), no con interpolate-size", () => {
        expect(css).toContain("grid-template-rows: 0fr");
        expect(css).toContain("grid-template-rows: 1fr");
        // `interpolate-size`/`calc-size()` animarían hasta `height:auto` y son más directas, pero en
        // 2026 solo las tiene Chromium: prometerían al autor algo que Firefox y Safari no cumplen.
        // Se mira el CÓDIGO, no la prosa: el comentario que explica esta decisión nombra ambas, así
        // que primero se quitan los comentarios y luego se comprueba que no se declaran.
        const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
        expect(/interpolate-size/.test(code)).toBe(false);
        expect(/calc-size/.test(code)).toBe(false);
    });

    it("el panel cerrado sale del árbol de accesibilidad y del orden de tabulación", () => {
        const block = css.slice(css.indexOf(".wjs-block-accordion__panel,"));
        expect(block.slice(0, 400)).toContain("visibility: hidden");
    });

    it("la transición vive dentro de prefers-reduced-motion: no-preference", () => {
        // Se localiza la transición del pliegue (tolerante a saltos de línea) y se comprueba que la
        // consulta de medios MÁS CERCANA por encima es la de «sin preferencia»: quien pide menos
        // movimiento abre y cierra al instante, sin recorrido.
        const i = css.search(/transition:\s*grid-template-rows/);
        expect(i).toBeGreaterThan(-1);
        const before = css.slice(0, i);
        const lastQuery = before.lastIndexOf("@media");
        expect(before.slice(lastQuery, lastQuery + 70)).toContain("prefers-reduced-motion: no-preference");
    });
});
