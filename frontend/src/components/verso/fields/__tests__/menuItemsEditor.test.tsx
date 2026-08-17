/**
 * Verso — tests de MenuItemsEditor (entorno node, sin jsdom — mismo patrón que
 * versoFieldControl.test.tsx: renderToStaticMarkup para el markup, y la lógica interacción→updates
 * ya está cubierta por menuItemsModel.test.ts, que es exactamente lo que invocan los handlers).
 *
 * menusApi se mockea a nivel de módulo: ningún test toca la red, y el contenedor se verifica en
 * sus estados DERIVABLES sin efectos (cargando / sin menú elegido / aviso fuera del editor).
 *
 * El comportamiento asíncrono del panel vive en helpers INYECTABLES exportados a propósito
 * (createMenuLoader, createAndAssignMenu, createAdminProbe): aquí se ejercitan con APIs mockeadas
 * y resoluciones fuera de orden — las carreras y reintentos exactos que el componente cablea.
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

import MenuItemsEditor, {
    MenuItemsPanel,
    MenuItemsTree,
    canManageMenus,
    createAdminProbe,
    createAndAssignMenu,
    createMenuLoader,
    menuBindingKey,
    type MenuLoadOutcome,
    type MenuTreeCallbacks,
} from "../MenuItemsEditor";
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

describe("createMenuLoader — guardia de secuencia contra cargas rancias (M1)", () => {
    it("una resolución RANCIA jamás aterriza: la carga más nueva gana aunque la vieja resuelva después", async () => {
        const commits: MenuLoadOutcome[] = [];
        let resolveOld!: (v: unknown) => void;
        let resolveNew!: (v: unknown) => void;
        const get = vi.fn()
            .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
            .mockImplementationOnce(() => new Promise((r) => { resolveNew = r; }));
        const load = createMenuLoader({ get, getByLocation: vi.fn() }, (o) => commits.push(o));

        // El refetch lento de una mutación (menú 1) compite con la carga del repunte (menú 2)…
        const first = load({ source: "menu", location: "header", menuId: 1 });
        const second = load({ source: "menu", location: "header", menuId: 2 });
        // …la NUEVA resuelve primero:
        resolveNew({ id: 2, name: "B", items: [{ id: 21, title: "b", url: "/b", parent: 0, order: 0 }] });
        await second;
        // …y la VIEJA después: sin guardia, este commit pisaría el estado y las altas siguientes
        // escribirían en el menú equivocado. Con guardia, se descarta.
        resolveOld({ id: 1, name: "A", items: [{ id: 11, title: "a", url: "/a", parent: 0, order: 0 }] });
        await first;

        expect(commits).toHaveLength(1);
        expect(commits[0].status).toBe("ready");
        expect(commits[0].menu).toEqual({ id: 2, name: "B" });
        expect(commits[0].items.map((it) => it.id)).toEqual([21]);
    });
});

describe("createAndAssignMenu — reintento idempotente (M4)", () => {
    it("create OK + setLocation KO → el reintento NO vuelve a crear, solo reasigna", async () => {
        const created: number[] = [];
        const create = vi.fn().mockResolvedValue({ id: 7 });
        const setLocation = vi.fn()
            .mockRejectedValueOnce(new Error("blip"))
            .mockResolvedValueOnce({ success: true });
        const api = { create, setLocation };

        await expect(createAndAssignMenu(api, "header", null, (id) => created.push(id))).rejects.toThrow("blip");
        expect(create).toHaveBeenCalledTimes(1);
        expect(created).toEqual([7]); // el id se recuerda ANTES de intentar la asignación

        // Reintento con el id recordado (lo que el panel guarda en createdMenuId):
        await createAndAssignMenu(api, "header", 7, (id) => created.push(id));
        expect(create).toHaveBeenCalledTimes(1); // ni un menú duplicado en el store
        expect(setLocation).toHaveBeenLastCalledWith(7, "header");
        expect(created).toEqual([7]); // onCreated no se re-invoca en el reintento
    });
});

describe("gate de solo lectura (M5)", () => {
    it("canManageMenus espeja el isAdmin del backend: solo el ROL administrator pasa", () => {
        expect(canManageMenus({ role: "administrator" })).toBe(true);
        // La capability '*' NO basta: el middleware isAdmin mira el rol, y enseñar la UI de
        // mutación a quien el backend va a rechazar es justo el defecto que el gate corrige.
        expect(canManageMenus({ role: "editor", capabilities: ["*"] })).toBe(false);
        expect(canManageMenus(null)).toBe(false);
        expect(canManageMenus("administrator")).toBe(false);
    });

    it("createAdminProbe con me() mockeado: admin→true, no-admin/401/403→false, red caída→null; y cachea", async () => {
        const meAdmin = vi.fn().mockResolvedValue({ role: "administrator" });
        const probeAdmin = createAdminProbe(meAdmin);
        expect(await probeAdmin()).toBe(true);
        expect(await probeAdmin()).toBe(true);
        expect(meAdmin).toHaveBeenCalledTimes(1); // promesa cacheada: una sonda por sesión

        expect(await createAdminProbe(vi.fn().mockResolvedValue({ role: "editor" }))()).toBe(false);
        const denied = Object.assign(new Error("auth/me 403"), { status: 403 });
        expect(await createAdminProbe(vi.fn().mockRejectedValue(denied))()).toBe(false);
        const unauth = Object.assign(new Error("auth/me 401"), { status: 401 });
        expect(await createAdminProbe(vi.fn().mockRejectedValue(unauth))()).toBe(false);
        // Fallo de red: no se supo — el gate queda abierto y manda el flip reactivo por 403.
        expect(await createAdminProbe(vi.fn().mockRejectedValue(new Error("network")))()).toBe(null);
    });

    it("el gate NO se hereda entre vinculaciones: la key del panel cambia al repuntar (remontaje)", () => {
        expect(menuBindingKey({ source: "menu", location: "header", menuId: 3 }))
            .not.toBe(menuBindingKey({ source: "menu", location: "header", menuId: 5 }));
        expect(menuBindingKey({ source: "location", location: "header", menuId: 0 }))
            .not.toBe(menuBindingKey({ source: "location", location: "footer", menuId: 0 }));
        expect(menuBindingKey({ source: "menu", location: "header", menuId: 3 }))
            .not.toBe(menuBindingKey({ source: "location", location: "header", menuId: 3 }));
        // Con origen "location" el menuId es irrelevante: misma key, sin remontajes espurios.
        expect(menuBindingKey({ source: "location", location: "header", menuId: 3 }))
            .toBe(menuBindingKey({ source: "location", location: "header", menuId: 9 }));
    });
});
