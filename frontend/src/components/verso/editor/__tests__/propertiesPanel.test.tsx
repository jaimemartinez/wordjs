/**
 * Verso — GATE del REDISEÑO del panel de propiedades (chrome de acordeón, sistema Stitch
 * "Architectural Precision").
 *
 * ENTORNO: node (sin jsdom, como el resto de `render/__tests__`), así que la ESTRUCTURA se fija con
 * `renderToStaticMarkup`. Eso da el estado inicial (las tres secciones abiertas) y no clics; el
 * plegado interactivo y el aspecto quedan para el gate de navegador.
 *
 * Se simulan las dependencias PESADAS del panel (i18n, presets de sitio, y los tres componentes que
 * pintan el CONTENIDO: campos, interacciones, iconos) a propósito: este test es sobre la CHROME que
 * cambió —cabecera, secciones plegables, reparto, pie, anclas de e2e—, no sobre los controles, que
 * tienen sus propios tests.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/contexts/I18nContext", () => ({
    useI18n: () => ({ t: (k: string) => k, language: "es" }),
}));
vi.mock("../../canvas/useSiteIxPresets", () => ({ useSiteIxPresets: () => ({}) }));
vi.mock("@/components/editor/MSym", () => ({
    default: ({ name }: { name: string }) => <i data-msym={name} />,
}));
vi.mock("../../fields/VersoFieldControl", () => ({
    default: ({ name }: { name: string }) => <div data-field={name} />,
}));
vi.mock("../../fields/InteractionsControl", () => ({
    default: () => <div data-ix="1" />,
}));
// El store: el panel llama `useStoreSlice(handle, selector)`; lo hacemos leer el estado que cada
// caso inyecta por el propio handle, para controlar la selección sin montar un editor entero.
vi.mock("../../render/context", () => ({
    useStoreSlice: (h: { __state: unknown }, sel: (s: unknown) => unknown) => sel(h.__state),
}));

import PropertiesPanel from "../PropertiesPanel";
import { withSharedVersoFields } from "@/lib/verso/sharedFields";
import type { BlockRegistry, VersoField } from "@/lib/verso/registry";

/**
 * La definición pasa por el PRODUCTOR REAL, `withSharedVersoFields`, en vez de declararse a mano.
 *
 * La versión anterior de este fichero fabricaba `{title, look, anim}` y daba por hecho que `anim`
 * caía en «Avanzado». Dos cosas fallaban con eso, y ninguna era del componente:
 *   · `ADVANCED_FIELD_KEYS` es `["hide"]` — la ÚNICA clave de esa sección. Como el fixture no pasaba
 *     por el productor, no tenía `hide`, así que la sección no existía y el test lo leía como un bug
 *     del panel.
 *   · `anim` está en `DOCK_FIELD_KEYS`: el reparto lo SALTA a propósito y lo entrega al dock inferior
 *     de movimiento, que no es este panel.
 * Registrar la definición como la registra el editor evita las dos suposiciones: `hide` aparece porque
 * el productor lo inyecta, y el reparto decide dónde va cada campo en vez de decidirlo el test.
 */
const HERO_DEF = withSharedVersoFields({
    label: "Sección Hero",
    fields: {
        title: { type: "text" } as VersoField,               // → Contenido
        look: { type: "custom" } as unknown as VersoField,   // → Estilo
        anim: { type: "custom" } as unknown as VersoField,   // → DOCK (no el inspector)
    },
    defaultProps: {},
    render: () => null,
    ixText: false,
} as never);

const registry = {
    get: (type: string) => (type === "Hero" ? HERO_DEF : undefined),
} as unknown as BlockRegistry;

function panelFor(state: unknown, rootFields: Record<string, VersoField> = {}) {
    const handle = { __state: state, transact: () => true } as never;
    return renderToStaticMarkup(
        <PropertiesPanel handle={handle} registry={registry} rootFields={rootFields} onClose={() => {}} />,
    );
}

const blockState = {
    selection: { nodeId: "n1" },
    doc: { nodes: { n1: { id: "n1", type: "Hero", props: { id: "hero-3f8a2c", title: "Hola" } } }, root: { props: {} } },
    dragPreview: null,
};

describe("PropertiesPanel — rediseño de acordeón", () => {
    it("bloque: cabecera con ID, tres secciones plegables, campos repartidos y pie de reset", () => {
        const html = panelFor(blockState);

        // Ancla de e2e + identidad.
        expect(html).toContain('data-verso-panel="block"');
        expect(html).toContain('data-verso-panel-node="n1"');
        expect(html).toContain("ID: hero-3f8a2c");
        expect(html).toContain("Sección Hero");

        // Las tres secciones existen, como acordeón (no pestañas), y nacen ABIERTAS.
        for (const s of ["content", "style", "advanced"]) {
            expect(html, `falta la sección ${s}`).toContain(`data-verso-section="${s}"`);
        }
        expect(html.match(/aria-expanded="true"/g)?.length, "las 3 secciones abiertas").toBe(3);

        // Reparto por partición: cada campo bajo su sección, y las interacciones en Avanzado.
        expect(html).toContain('data-field="title"');   // content
        expect(html).toContain('data-field="look"');    // style
        expect(html).toContain('data-field="hide"');    // advanced — lo inyecta el productor compartido
        // …y lo que este panel NO pinta, que es la otra mitad del reparto: `anim` está en
        // DOCK_FIELD_KEYS y las interacciones viven en IxDock, montado por VersoEditor, no aquí.
        // Afirmarlo en positivo pedía al inspector el contenido de otro componente.
        expect(html).not.toContain('data-field="anim"');
        expect(html).not.toContain('data-ix=');

        // Pie de reset (undoable) presente con un bloque que tiene estilo/avanzado.
        expect(html).toContain("Restablecer estilos");
    });

    it("página (sin selección): modo root, sin interacciones y sin pie de reset", () => {
        const rootState = {
            selection: { nodeId: null },
            doc: { nodes: {}, root: { props: {} } },
            dragPreview: null,
        };
        const html = panelFor(rootState, { siteTitle: { type: "text" } as VersoField });

        expect(html).toContain('data-verso-panel="root"');
        expect(html).toContain("editor.properties"); // la línea del ID cae al t('editor.properties')
        expect(html).toContain('data-field="siteTitle"');
        // La página no se anima ni se "restablece": ni interacciones ni pie.
        expect(html).not.toContain('data-ix="1"');
        expect(html).not.toContain("Restablecer estilos");
    });

    it("durante un drag, el panel se bloquea con su aviso", () => {
        const html = panelFor({ ...blockState, dragPreview: { some: "preview" } });
        expect(html).toContain("Panel bloqueado");
    });
});
