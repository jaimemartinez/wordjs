/**
 * F3 ola 3 — acciones de la CommandPalette ⌘K (checklist W29): el builder puro
 * buildVersoPaletteActions emite los comandos correctos sobre un handle REAL (createEditor) y
 * delega en los callbacks inyectados — ids/glifos/hints con la espec del paletteActions legacy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockRegistry } from "@/lib/verso/registry";
import type { VersoItem } from "@/lib/verso/types";
import { STYLE_CLIPBOARD_KEY } from "../blockClipboard";
import {
    buildVersoPaletteActions,
    importDataIntoHandle,
    saveSelectedAsSymbol,
    type VersoPaletteActionDeps,
} from "../paletteActions";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        store.set(k, String(v));
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
});

function makeRegistry(): BlockRegistry {
    const r = createBlockRegistry();
    r.register([
        {
            type: "Heading",
            fields: { title: { type: "text" } },
            defaultProps: { title: "Un título" },
            render: () => null,
        },
        {
            type: "Text",
            fields: { content: { type: "textarea" } },
            defaultProps: { content: "..." },
            render: () => null,
        },
        {
            type: "Section",
            label: "Sección",
            fields: { children: { type: "slot" } },
            defaultProps: {},
            render: () => null,
        },
        {
            type: "Symbol",
            fields: { symbolId: { type: "custom", render: () => null } },
            defaultProps: { symbolId: 0 },
            render: () => null,
        },
    ]);
    return r;
}

function makeHandle(registry: BlockRegistry, content: VersoItem[] = []) {
    return createEditor({
        initialData: { content, root: { props: { title: "Doc" } } },
        isSlot: makeSlotResolver(registry),
    });
}

function makeDeps(handle: ReturnType<typeof makeHandle>, over: Partial<VersoPaletteActionDeps> = {}) {
    const deps = {
        handle,
        tr: (s: string) => s, // identidad: los labels quedan en ES fuente, como llegan a trStr
        status: "draft",
        hasSave: true,
        hasPreview: true,
        save: vi.fn(),
        preview: vi.fn(),
        exportDoc: vi.fn(),
        importDoc: vi.fn(),
        toast: vi.fn(),
        openPageSettings: vi.fn(),
        openOutline: vi.fn(),
        replayAnims: vi.fn(),
        hasPage: true,
        openMedia: vi.fn(),
        openRevisions: vi.fn(),
        openComments: vi.fn(),
        openA11y: vi.fn(),
        toggleGuides: vi.fn(),
        saveSymbol: vi.fn(),
        ...over,
    };
    return { deps, actions: buildVersoPaletteActions(deps) };
}

const find = (actions: { id: string }[], id: string) => {
    const a = actions.find((x) => x.id === id);
    if (!a) throw new Error(`acción ${id} ausente`);
    return a as { id: string; ms: string; label: string; hint?: string; run: () => void };
};

beforeEach(() => {
    store.clear();
});

describe("presencia y espec de las filas (ids/glifos/hints del legacy)", () => {
    it("save/preview solo con hasSave/hasPreview; labels según status", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        const { actions } = makeDeps(handle);
        expect(find(actions, "save").label).toBe("Guardar");
        expect(find(actions, "save").hint).toBe("Ctrl+S");
        expect(find(actions, "preview").ms).toBe("open_in_new");

        const { actions: published } = makeDeps(handle, { status: "publish" });
        expect(find(published, "save").label).toBe("Publicar");

        const { actions: bare } = makeDeps(handle, { hasSave: false, hasPreview: false });
        expect(bare.some((a) => a.id === "save")).toBe(false);
        expect(bare.some((a) => a.id === "preview")).toBe(false);
    });

    it("hints de bloque del blueprint: Ctrl+D en duplicar, Supr en eliminar", () => {
        const registry = makeRegistry();
        const { actions } = makeDeps(makeHandle(registry));
        expect(find(actions, "duplicate").hint).toBe("Ctrl+D");
        expect(find(actions, "duplicate").ms).toBe("content_copy");
        expect(find(actions, "delete-block").hint).toBe("Supr");
        expect(find(actions, "delete-block").ms).toBe("delete");
    });

    it("superficies (ola 4): media/a11y/guías siempre; revisiones/comentarios solo con hasPage", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        const { deps, actions } = makeDeps(handle);
        expect(find(actions, "media").ms).toBe("image");
        expect(find(actions, "media").label).toBe("Biblioteca de medios");
        expect(find(actions, "revisions").ms).toBe("history");
        expect(find(actions, "comments").ms).toBe("forum");
        expect(find(actions, "a11y").ms).toBe("check_circle");
        expect(find(actions, "a11y").label).toBe("Auditoría de accesibilidad");
        expect(find(actions, "guides").ms).toBe("grid_view");
        find(actions, "media").run();
        find(actions, "revisions").run();
        find(actions, "comments").run();
        find(actions, "a11y").run();
        find(actions, "guides").run();
        expect(deps.openMedia).toHaveBeenCalledTimes(1);
        expect(deps.openRevisions).toHaveBeenCalledTimes(1);
        expect(deps.openComments).toHaveBeenCalledTimes(1);
        expect(deps.openA11y).toHaveBeenCalledTimes(1);
        expect(deps.toggleGuides).toHaveBeenCalledTimes(1);

        // Sin registro persistido (borrador nuevo) no hay revisiones ni notas — mismo gate pageId.
        const { actions: draft } = makeDeps(handle, { hasPage: false });
        expect(draft.some((a) => a.id === "revisions")).toBe(false);
        expect(draft.some((a) => a.id === "comments")).toBe(false);
        expect(draft.some((a) => a.id === "media")).toBe(true);
    });
});

describe("acciones que emiten comandos sobre el handle", () => {
    const seed = (): VersoItem[] => [
        { type: "Heading", props: { id: "h-1", title: "Uno" } },
        { type: "Text", props: { id: "t-2", content: "Dos" } },
    ];

    it("duplicate duplica el subtree seleccionado justo después", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, seed());
        handle.select("h-1");
        const { actions } = makeDeps(handle);
        find(actions, "duplicate").run();
        const content = handle.getData().content;
        expect(content.length).toBe(3);
        expect(content[1].type).toBe("Heading");
        expect(content[1].props.id).not.toBe("h-1");
    });

    it("delete-block elimina la selección; sin selección = no-op", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, seed());
        const { actions } = makeDeps(handle);
        find(actions, "delete-block").run(); // sin selección
        expect(handle.getData().content.length).toBe(2);
        handle.select("t-2");
        find(actions, "delete-block").run();
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["h-1"]);
    });

    it("move-up / move-down mueven la selección un puesto con clamp en los bordes", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, seed());
        const { actions } = makeDeps(handle);
        handle.select("t-2");
        find(actions, "move-up").run();
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["t-2", "h-1"]);
        find(actions, "move-up").run(); // ya está arriba → clamp, sin transacción
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["t-2", "h-1"]);
        find(actions, "move-down").run();
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["h-1", "t-2"]);
    });

    it("la selección se lee PEREZOSAMENTE al ejecutar (no al construir las acciones)", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, seed());
        const { actions } = makeDeps(handle); // construidas SIN selección
        handle.select("h-1"); // la selección llega después
        find(actions, "duplicate").run();
        expect(handle.getData().content.length).toBe(3);
    });

    it("copy-styles/paste-styles: tripleta compartida + toast solo en copia exitosa", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [
            { type: "Heading", props: { id: "h-1", title: "x", look: { bg: "#000" } } },
            { type: "Text", props: { id: "t-2", content: "y" } },
        ]);
        const { deps, actions } = makeDeps(handle);

        find(actions, "copy-styles").run(); // sin selección → ni escribe ni toastea
        expect(deps.toast).not.toHaveBeenCalled();

        handle.select("h-1");
        find(actions, "copy-styles").run();
        expect(deps.toast).toHaveBeenCalledWith("Estilos copiados");
        expect(JSON.parse(store.get(STYLE_CLIPBOARD_KEY) as string).look).toEqual({ bg: "#000" });

        handle.select("t-2");
        find(actions, "paste-styles").run();
        expect(handle.getData().content[1].props.look).toEqual({ bg: "#000" });
    });

    it("export entrega el getData() VIVO del handle al callback", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, seed());
        const { deps, actions } = makeDeps(handle);
        handle.transact((tx) => tx.setProps("h-1", { title: "Editado" }));
        find(actions, "export").run();
        expect(deps.exportDoc).toHaveBeenCalledTimes(1);
        const exported = (deps.exportDoc as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(exported.content[0].props.title).toBe("Editado"); // vivo, sin mirrors
    });

    it("page-settings / outline / replay / import delegan en sus callbacks", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        const { deps, actions } = makeDeps(handle);
        find(actions, "page-settings").run();
        find(actions, "outline").run();
        find(actions, "replay").run();
        find(actions, "import").run();
        expect(deps.openPageSettings).toHaveBeenCalledTimes(1);
        expect(deps.openOutline).toHaveBeenCalledTimes(1);
        expect(deps.replayAnims).toHaveBeenCalledTimes(1);
        expect(deps.importDoc).toHaveBeenCalledTimes(1);
        find(actions, "save").run();
        find(actions, "preview").run();
        expect(deps.save).toHaveBeenCalledTimes(1);
        expect(deps.preview).toHaveBeenCalledTimes(1);
    });
});

describe("importDataIntoHandle (import JSON = UNA entrada de undo)", () => {
    it("sustituye el documento entero y UN solo Ctrl+Z lo restaura", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Text", props: { id: "t-1", content: "antes" } }]);
        const imported = {
            content: [
                { type: "Heading", props: { id: "h-9", title: "Importado" } },
                { type: "Text", props: { id: "t-9", content: "también" } },
            ],
            root: { props: { title: "Otra" } },
        };
        expect(importDataIntoHandle(handle, imported)).toBe(true);
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["h-9", "t-9"]);
        expect(handle.undo()).toBe(true); // UNA entrada
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["t-1"]);
        expect(handle.canUndo()).toBe(false);
    });

    it("forma inválida → false sin tocar doc ni historia (mismo criterio que el legacy)", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Text", props: { id: "t-1", content: "x" } }]);
        const before = handle.getData();
        expect(importDataIntoHandle(handle, null)).toBe(false);
        expect(importDataIntoHandle(handle, "texto")).toBe(false);
        expect(importDataIntoHandle(handle, [])).toBe(false);
        expect(importDataIntoHandle(handle, { root: {} })).toBe(false); // sin content[]
        expect(importDataIntoHandle(handle, { content: "no-array" })).toBe(false);
        expect(handle.getData()).toEqual(before);
        expect(handle.canUndo()).toBe(false);
    });
});

describe("W35 — Guardar bloque como símbolo", () => {
    it("la fila save-symbol lleva el id/glifo/label del legacy y delega en el callback", () => {
        const registry = makeRegistry();
        const { deps, actions } = makeDeps(makeHandle(registry));
        const row = find(actions, "save-symbol");
        expect(row.ms).toBe("collections");
        expect(row.label).toBe("Guardar bloque como símbolo");
        // Misma posición relativa que el legacy: tras replay y antes de comments.
        const ids = actions.map((a) => a.id);
        expect(ids.indexOf("save-symbol")).toBeGreaterThan(ids.indexOf("replay"));
        expect(ids.indexOf("save-symbol")).toBeLessThan(ids.indexOf("comments"));
        row.run();
        expect(deps.saveSymbol).toHaveBeenCalledTimes(1);
    });

    it("serializa el SUBTREE seleccionado (slots incluidos), descarta props resueltas y nombra <label> · <stamp>", async () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [
            {
                type: "Section",
                props: {
                    id: "s-1",
                    resolvedPosts: [{ fake: true }],
                    resolvedFiltered: [1],
                    resolvedSymbolItems: [2],
                    children: [{ type: "Text", props: { id: "t-1", content: "dentro" } }],
                },
            },
        ]);
        handle.select("s-1");
        const create = vi.fn().mockResolvedValue({ id: 9 });
        const result = await saveSelectedAsSymbol(handle, {
            create,
            labelOf: (type) => (type === "Section" ? "Sección" : type),
            stamp: () => "12:34",
        });
        expect(result).toBe("saved");
        expect(create).toHaveBeenCalledTimes(1);
        const [name, items] = create.mock.calls[0];
        expect(name).toBe("Sección · 12:34");
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe("Section");
        // El subtree viaja completo (forma cruda Puck: hijos como array dentro de props)…
        expect(items[0].props.children).toEqual([{ type: "Text", props: { id: "t-1", content: "dentro" } }]);
        // …y las props inyectadas por el resolver SSR jamás se persisten (legacy L1580-1583).
        expect("resolvedPosts" in items[0].props).toBe(false);
        expect("resolvedFiltered" in items[0].props).toBe(false);
        expect("resolvedSymbolItems" in items[0].props).toBe(false);
        // El documento y la historia quedan intactos: guardar un símbolo no es una edición.
        expect(handle.canUndo()).toBe(false);
    });

    it("sin selección → skipped; seleccionar un Symbol → skipped (mismo guard del legacy); nunca llama a create", async () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Symbol", props: { id: "sym-1", symbolId: 3 } }]);
        const create = vi.fn();
        expect(await saveSelectedAsSymbol(handle, { create, labelOf: (t) => t })).toBe("skipped");
        handle.select("sym-1");
        expect(await saveSelectedAsSymbol(handle, { create, labelOf: (t) => t })).toBe("skipped");
        expect(create).not.toHaveBeenCalled();
    });

    it("create() rechaza → 'error' (el llamador alerta), sin excepción hacia arriba", async () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Text", props: { id: "t-1", content: "x" } }]);
        handle.select("t-1");
        const create = vi.fn().mockRejectedValue(new Error("red caída"));
        expect(await saveSelectedAsSymbol(handle, { create, labelOf: (t) => t })).toBe("error");
    });
});
