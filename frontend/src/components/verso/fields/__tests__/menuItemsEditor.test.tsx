/**
 * Verso — tests de render de MenuItemsEditor (entorno node, sin jsdom — mismo patrón que
 * versoFieldControl.test.tsx: renderToStaticMarkup para el markup, y la lógica interacción→updates
 * ya está cubierta por menuItemsModel.test.ts, que es exactamente lo que invocan los handlers).
 *
 * menusApi se mockea a nivel de módulo: ningún test toca la red, y el contenedor se verifica en
 * sus estados DERIVABLES sin efectos (cargando / sin menú elegido / aviso fuera del editor).
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/api", () => ({
    menusApi: {
        list: vi.fn(() => new Promise(() => undefined)),
        get: vi.fn(() => new Promise(() => undefined)),
        getByLocation: vi.fn(() => new Promise(() => undefined)),
        getLocations: vi.fn(() => new Promise(() => undefined)),
        create: vi.fn(),
        setLocation: vi.fn(),
        addItem: vi.fn(),
        updateItem: vi.fn(),
        deleteItem: vi.fn(),
    },
}));

import MenuItemsEditor, { MenuItemsPanel, MenuItemsTree, type MenuTreeCallbacks } from "../MenuItemsEditor";
import type { ChromeMenuItem } from "@/lib/chromeData";

const noopCallbacks: MenuTreeCallbacks = {
    onMove: () => undefined,
    onIndent: () => undefined,
    onOutdent: () => undefined,
    onEdit: () => undefined,
    onDeleteAsk: () => undefined,
    onDeleteConfirm: () => undefined,
    onDeleteCancel: () => undefined,
};

const TREE: ChromeMenuItem[] = [
    { id: 1, title: "Inicio", url: "/", order: 0, children: [] },
    {
        id: 2, title: "Blog", url: "/blog", order: 1, children: [
            { id: 4, title: "Sub1", url: "/s1", order: 0, children: [] },
            { id: 5, title: "Sub2", url: "/s2", order: 1, children: [] },
        ],
    },
    { id: 3, title: "Contacto", url: "/contacto", order: 2, children: [] },
];

function renderTree(extra?: Partial<React.ComponentProps<typeof MenuItemsTree>>): string {
    return renderToStaticMarkup(
        <MenuItemsTree
            nodes={TREE}
            readOnly={false}
            busy={false}
            deletingId={null}
            callbacks={noopCallbacks}
            {...extra}
        />,
    );
}

describe("MenuItemsTree — árbol anidado y estados de los botones", () => {
    it("renderiza la jerarquía: nivel 0 y nivel 1 con los títulos como TEXTO plano", () => {
        const html = renderTree();
        expect(html).toContain('data-menu-depth="0"');
        expect(html).toContain('data-menu-depth="1"');
        for (const title of ["Inicio", "Blog", "Contacto", "Sub1", "Sub2"]) {
            expect(html).toContain(title);
        }
    });

    it("bordes deshabilitados: subir del primero, bajar del último, anidar el primero", () => {
        const html = renderTree();
        // aria-labels posicionan cada botón sin ambigüedad. El ATRIBUTO es `disabled=""` — a secas
        // «disabled» matchearía la clase tailwind disabled:opacity-40 de TODOS los botones.
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Subir Inicio"/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Bajar Contacto"/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Anidar Inicio"/);
        // Y el desanidar de un elemento RAÍZ está deshabilitado; el de un hijo, no.
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Desanidar Inicio"/);
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Desanidar Sub1"/);
    });

    it("readOnly: la lista se ve, ningún botón de mutación existe", () => {
        const html = renderTree({ readOnly: true });
        expect(html).toContain("Inicio");
        expect(html).not.toContain("aria-label=\"Subir");
        expect(html).not.toContain("aria-label=\"Borrar");
    });

    it("borrado en dos pasos: con deletingId se muestran Sí/No y la advertencia de hijos", () => {
        const html = renderTree({ deletingId: 2 });
        expect(html).toContain("¿Borrar? (sus hijos suben de nivel)");
        expect(html).toContain('aria-label="Confirmar borrado de Blog"');
        expect(html).toContain('aria-label="Cancelar borrado"');
        // El resto de filas conserva sus acciones normales.
        expect(html).toContain('aria-label="Editar Inicio"');
    });

    it("árbol vacío en la raíz → aviso, no una lista hueca", () => {
        const html = renderToStaticMarkup(
            <MenuItemsTree nodes={[]} readOnly={false} busy={false} deletingId={null} callbacks={noopCallbacks} />,
        );
        expect(html).toContain("El menú no tiene elementos todavía.");
    });
});

describe("MenuItemsPanel — estados derivables sin efectos", () => {
    it("referencia por menú SIN menú elegido → aviso de vinculación, sin fetch a la vista", () => {
        const html = renderToStaticMarkup(
            <MenuItemsPanel binding={{ source: "menu", location: "header", menuId: 0 }} />,
        );
        expect(html).toContain("Elige un menú");
        expect(html).not.toContain("Cargando el menú…");
    });

    it("referencia por ubicación → primer render en estado de carga", () => {
        const html = renderToStaticMarkup(
            <MenuItemsPanel binding={{ source: "location", location: "header", menuId: 0 }} />,
        );
        expect(html).toContain("Cargando el menú…");
    });
});

describe("MenuItemsEditor — fuera del editor Verso", () => {
    it("sin VersoPanelHandleContext degrada a un aviso (jamás revienta)", () => {
        const html = renderToStaticMarkup(<MenuItemsEditor />);
        expect(html).toContain("Elementos del menú");
        expect(html).toContain("se editan desde el panel de propiedades del editor Verso");
    });
});
