/**
 * Verso — interacciones en el SITIO PÚBLICO (F9-B/E): lo que ContentRenderer emite.
 *
 * El compilador ya tiene sus propios tests; lo que se prueba aquí es lo que solo se puede romper al
 * cablear: que la hoja SALE (y con el grupo de cascada correcto), que la clase que estampa el bloque
 * es la que la hoja define, que una página sin interacciones no emite NADA, y —el contrato que más
 * caro sale de romper— que **el HTML servido nunca oculta un bloque**.
 *
 * Entorno node sin jsdom, como el resto de tests de content/: renderToStaticMarkup con los
 * componentes REALES. React 19 hoistea `<style href precedence>` al principio de la salida con
 * `data-precedence`/`data-href` (en un documento real, al `<head>`), así que se puede afirmar sobre
 * el markup en vez de sobre una promesa.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { collectIxSpecs, compileIxPage, ixCtxFromSetting } from "@/lib/verso/interactions";
import ContentRenderer from "../ContentRenderer";

const SITE_PRESETS = JSON.stringify([
  {
    id: "aparecer-tarjetas",
    name: "Aparecer tarjetas",
    trigger: { on: "view", once: false },
    tracks: [
      {
        target: { kind: "self" },
        steps: [
          { at: 0, set: { opacity: 0, y: 24 }, ease: "out" },
          { at: 100, set: { opacity: 1, y: 0 } },
        ],
      },
    ],
    rev: 4,
  },
]);

const heading = (id: string, ix?: unknown) => ({
  type: "Heading",
  props: { id, title: `Título ${id}`, level: "h2", ...(ix === undefined ? {} : { ix }) },
});

/** El markup SIN la hoja: `data-wjs-ix` aparece dentro del CSS a propósito (el selector del
 *  estado armado), y confundirlo con un atributo del HTML servido sería exactamente el error que
 *  este test existe para cazar. */
const markupOnly = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, "");

const render = (data: unknown, ixPresets?: unknown): string =>
  renderToStaticMarkup(<ContentRenderer data={data} ixPresets={ixPresets} />);

describe("ContentRenderer — la hoja de interacciones", () => {
  it("una página sin interacciones no emite NI UNA etiqueta del motor", () => {
    const html = render({ content: [heading("a"), heading("b")] });
    expect(html).not.toContain("data-precedence=\"wjs-ix\"");
    expect(html).not.toContain("wjs-ix-");
    expect(html).not.toContain("@keyframes");
  });

  it("con interacciones emite UNA hoja en el grupo `wjs-ix` (framework < tema < interacciones)", () => {
    const html = render({ content: [heading("a", { v: 1, preset: "sys:fade-up" })] });
    expect(html).toContain('data-precedence="wjs-ix"');
    expect(html.match(/data-precedence="wjs-ix"/g)).toHaveLength(1);
    expect(html).toContain("@keyframes wjs-ixk-");
    // href derivado del CONTENIDO y sin espacios (React avisa si los hay).
    const href = html.match(/data-href="([^"]+)"/);
    expect(href).not.toBeNull();
    expect(href![1]).toMatch(/^wjs-ix-[a-z0-9]+$/);
  });

  it("la clase que estampa el bloque es EXACTAMENTE la que la hoja define", () => {
    const data = { content: [heading("a", { v: 1, preset: "sys:fade-up" })] };
    const html = render(data);
    const page = compileIxPage(collectIxSpecs(data), ixCtxFromSetting(undefined));
    expect(page.units).toHaveLength(1);
    expect(html).toContain(`class="${page.units[0].cls}"`);
    expect(html).toContain(`.${page.units[0].cls}`); // el selector, dentro de la hoja
  });

  it("40 bloques con el mismo preajuste: UNA clase, UN juego de reglas, UNA etiqueta", () => {
    const content = Array.from({ length: 40 }, (_, i) =>
      heading(`h${i}`, { v: 1, preset: "sys:fade-up" }),
    );
    const html = render({ content });
    expect(html.match(/data-precedence="wjs-ix"/g)).toHaveLength(1);
    expect(html.match(/@keyframes wjs-ixk-/g)).toHaveLength(1);
    const cls = html.match(/class="(wjs-ix-[a-z0-9]+)"/)![1];
    expect(html.match(new RegExp(`class="${cls}"`, "g"))).toHaveLength(40);
  });

  it("TODO el CSS emitido va bajo `prefers-reduced-motion: no-preference`", () => {
    const html = render({ content: [heading("a", { v: 1, preset: "sys:fade-up" })] });
    expect(html).toContain("@media screen and (prefers-reduced-motion:no-preference){");
    // Y nada de animación fuera de esa guarda: la hoja es UN bloque `@media` y punto.
    const sheet = html.match(/data-href="[^"]+">([\s\S]*?)<\/style>/)![1];
    expect(sheet.startsWith("@media screen and (prefers-reduced-motion:no-preference){")).toBe(true);
  });
});

describe("ContentRenderer — cero CLS, cero FOUC: el servidor no oculta nada", () => {
  it("el HTML servido NUNCA lleva `data-wjs-ix` (el estado armado lo pone el runtime, o nadie)", () => {
    const html = render({
      content: [
        heading("a", { v: 1, preset: "sys:fade-up" }), // view+once → necesita runtime
        heading("b", { v: 1, preset: "sys:parallax" }), // scrub → CSS nativo
      ],
    });
    expect(markupOnly(html)).not.toContain("data-wjs-ix=");
    // El atributo informativo del disparador SÍ va (hace el markup autodescriptivo).
    expect(html).toContain('data-wjs-ix-on="view"');
    expect(html).toContain('data-wjs-ix-on="scrub"');
  });

  it("ninguna regla del estado inicial se aplica sin el atributo que solo escribe el JS", () => {
    const html = render({ content: [heading("a", { v: 1, preset: "sys:fade-up" })] });
    const sheet = html.match(/data-href="[^"]+">([\s\S]*?)<\/style>/)![1];
    // `opacity:0` solo puede aparecer dentro de los @keyframes o tras `[data-wjs-ix="armed"]`.
    for (const rule of sheet.split("}").filter((r) => r.includes("opacity:0"))) {
      const isKeyframe = /\d+%\{/.test(rule);
      const isArmed = rule.includes('[data-wjs-ix="armed"]');
      expect(isKeyframe || isArmed, `regla que oculta sin atributo: ${rule}`).toBe(true);
    }
  });
});

describe("ContentRenderer — presets del SITIO (F9-E)", () => {
  it("un bloque que referencia un preajuste del sitio se compila y se estampa", () => {
    const data = { content: [heading("a", { v: 1, preset: "aparecer-tarjetas" })] };
    const html = render(data, SITE_PRESETS);
    const page = compileIxPage(collectIxSpecs(data), ixCtxFromSetting(SITE_PRESETS));
    expect(page.units).toHaveLength(1);
    expect(html).toContain(`class="${page.units[0].cls}"`);
    expect(html).toContain("data-precedence=\"wjs-ix\"");
  });

  it("sin el ajuste, la MISMA página se sirve entera y sin movimiento (fail-open)", () => {
    const html = render({ content: [heading("a", { v: 1, preset: "aparecer-tarjetas" })] });
    expect(html).toContain("Título a"); // el contenido está
    expect(html).not.toContain("data-precedence=\"wjs-ix\""); // el movimiento no
  });

  it("editar el preajuste (rev++) cambia el href de la hoja: el navegador no puede servir la vieja", () => {
    const data = { content: [heading("a", { v: 1, preset: "aparecer-tarjetas" })] };
    const v5 = SITE_PRESETS.replace('"rev":4', '"rev":5');
    const hrefOf = (presets: string) => render(data, presets).match(/data-href="([^"]+)"/)![1];
    expect(hrefOf(SITE_PRESETS)).not.toBe(hrefOf(v5));
  });

  it("un ajuste corrupto no rompe la página: se sirve entera, sin presets de sitio", () => {
    for (const bad of ["{", "null", "[1,2,3]", '{"a":1}', "no soy json"]) {
      const html = render({ content: [heading("a", { v: 1, preset: "aparecer-tarjetas" })] }, bad);
      expect(html).toContain("Título a");
      expect(html).not.toContain("data-precedence=\"wjs-ix\"");
    }
  });
});

describe("ContentRenderer — bloques anidados", () => {
  it("una interacción dentro de un slot también compila y estampa", () => {
    const data = {
      content: [
        {
          type: "Section",
          props: {
            id: "s",
            children: [heading("dentro", { v: 1, preset: "sys:zoom" })],
          },
        },
      ],
    };
    const html = render(data);
    const page = compileIxPage(collectIxSpecs(data), ixCtxFromSetting(undefined));
    expect(page.units).toHaveLength(1);
    expect(html).toContain(`class="${page.units[0].cls}"`);
  });

  it("la capa de interacción es un elemento REAL y envuelve al bloque (nunca display:contents)", () => {
    const html = render({ content: [heading("a", { v: 1, preset: "sys:fade-up" })] });
    expect(html).toMatch(/<div class="wjs-ix-[a-z0-9]+" data-wjs-ix-on="view">[\s\S]*<h2/);
  });
});
