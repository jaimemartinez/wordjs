/**
 * Verso — tests de la lógica del ActionBar (F2): modelo (habilitación de
 * acciones) y comandos EXACTOS emitidos al handle. Los comandos se verifican
 * contra un handle MOCK que graba lo que la transacción emite (la capa de
 * chrome jamás muta el doc: solo emite comandos); la semántica real de
 * moveNode (índice post-remoción) se contrasta además contra un editor REAL.
 */
import { describe, expect, it, vi } from "vitest";
import {
    createEditor,
    type EditorHandle,
    type VersoTransactionApi,
} from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockRegistry } from "@/lib/verso/registry";
import { ROOT_ID, ROOT_SLOT, type VersoData } from "@/lib/verso/types";
import {
    actionBarModel,
    duplicateSelected,
    editSelectedInline,
    moveSelected,
    removeSelected,
    siblingIdsOf,
} from "../actionBarCommands";

function makeRegistry(): BlockRegistry {
    const registry = createBlockRegistry();
    const render = () => null;
    registry.register([
        {
            type: "Heading",
            label: "Encabezado",
            fields: { title: { type: "text" } },
            defaultProps: {},
            inline: { prop: "title", schema: "plain" },
            render,
        },
        {
            type: "Text",
            label: "Texto",
            fields: { content: { type: "textarea" } },
            defaultProps: {},
            inline: { prop: "content", schema: "rich" },
            render,
        },
        { type: "Card", label: "Tarjeta", fields: { title: { type: "text" } }, defaultProps: {}, render },
        {
            type: "Section",
            label: "Sección",
            fields: { children: { type: "slot" } },
            defaultProps: {},
            render,
        },
    ]);
    return registry;
}

// Raíz: [a(Heading), s1(Section children:[b,c,d]), e(Text)]
function makeData(): VersoData {
    return {
        content: [
            { type: "Heading", props: { id: "a", title: "Hola" } },
            {
                type: "Section",
                props: {
                    id: "s1",
                    children: [
                        { type: "Card", props: { id: "b", title: "B" } },
                        { type: "Card", props: { id: "c", title: "C" } },
                        { type: "Card", props: { id: "d", title: "D" } },
                    ],
                },
            },
            { type: "Text", props: { id: "e", content: "<p>fin</p>" } },
        ],
        root: { props: {} },
    };
}

function makeRealEditor(): { handle: EditorHandle; registry: BlockRegistry } {
    const registry = makeRegistry();
    const handle = createEditor({ initialData: makeData(), isSlot: makeSlotResolver(registry) });
    return { handle, registry };
}

/** Handle mock: getDoc real, transact graba los comandos que emite la lógica. */
function makeRecordingHandle(real: EditorHandle) {
    const calls: unknown[][] = [];
    const record =
        (kind: string) =>
        (...args: unknown[]) => {
            calls.push([kind, ...args]);
        };
    const tx = {
        insertNode: record("insertNode"),
        moveNode: record("moveNode"),
        removeNode: record("removeNode"),
        setProps: record("setProps"),
        setRootProps: record("setRootProps"),
        duplicateSubtree: record("duplicateSubtree"),
        replaceData: record("replaceData"),
    } as unknown as VersoTransactionApi;
    const transact = vi.fn((fn: (t: VersoTransactionApi) => void): boolean => {
        fn(tx);
        return true;
    });
    const setInlineEditing = vi.fn();
    const handle = {
        getDoc: () => real.getDoc(),
        transact,
        setInlineEditing,
    } as unknown as EditorHandle;
    return { handle, calls, transact, setInlineEditing };
}

describe("actionBarModel — habilitación de acciones", () => {
    it("clampa subir/bajar en los extremos del slot y de la raíz", () => {
        const { handle, registry } = makeRealEditor();
        const doc = handle.getDoc();
        // Extremos del slot anidado.
        expect(actionBarModel(doc, registry, "b")).toMatchObject({ canMoveUp: false, canMoveDown: true });
        expect(actionBarModel(doc, registry, "c")).toMatchObject({ canMoveUp: true, canMoveDown: true });
        expect(actionBarModel(doc, registry, "d")).toMatchObject({ canMoveUp: true, canMoveDown: false });
        // Extremos de la raíz.
        expect(actionBarModel(doc, registry, "a")).toMatchObject({ canMoveUp: false, canMoveDown: true });
        expect(actionBarModel(doc, registry, "e")).toMatchObject({ canMoveUp: true, canMoveDown: false });
    });

    it("canEditInline refleja la declaración `inline` del registry; label sale del registry", () => {
        const { handle, registry } = makeRealEditor();
        const doc = handle.getDoc();
        expect(actionBarModel(doc, registry, "a")).toMatchObject({ canEditInline: true, label: "Encabezado" });
        expect(actionBarModel(doc, registry, "e")).toMatchObject({ canEditInline: true, label: "Texto" });
        expect(actionBarModel(doc, registry, "c")).toMatchObject({ canEditInline: false, label: "Tarjeta" });
    });

    it("nodo inexistente → null; siblingIdsOf resuelve raíz y slot", () => {
        const { handle, registry } = makeRealEditor();
        const doc = handle.getDoc();
        expect(actionBarModel(doc, registry, "no-existe")).toBeNull();
        expect(siblingIdsOf(doc, doc.nodes["a"])).toEqual(["a", "s1", "e"]);
        expect(siblingIdsOf(doc, doc.nodes["c"])).toEqual(["b", "c", "d"]);
    });
});

describe("comandos emitidos al handle (mock)", () => {
    it("subir emite moveNode al MISMO slot con índice-1 (semántica post-remoción)", () => {
        const { handle: real } = makeRealEditor();
        const { handle, calls } = makeRecordingHandle(real);
        expect(moveSelected(handle, "c", -1)).toBe(true);
        expect(calls).toEqual([["moveNode", "c", "s1", "children", 0]]);
    });

    it("bajar emite moveNode con índice+1; en la raíz usa ROOT_ID/ROOT_SLOT", () => {
        const { handle: real } = makeRealEditor();
        const { handle, calls } = makeRecordingHandle(real);
        expect(moveSelected(handle, "c", 1)).toBe(true);
        expect(moveSelected(handle, "a", 1)).toBe(true);
        expect(calls).toEqual([
            ["moveNode", "c", "s1", "children", 2],
            ["moveNode", "a", ROOT_ID, ROOT_SLOT, 1],
        ]);
    });

    it("clamp: subir el primero / bajar el último NO abre transacción", () => {
        const { handle: real } = makeRealEditor();
        const { handle, calls, transact } = makeRecordingHandle(real);
        expect(moveSelected(handle, "b", -1)).toBe(false);
        expect(moveSelected(handle, "d", 1)).toBe(false);
        expect(moveSelected(handle, "e", 1)).toBe(false);
        expect(transact).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
    });

    it("duplicar y borrar emiten duplicateSubtree/removeNode; nodo inexistente → false sin transacción", () => {
        const { handle: real } = makeRealEditor();
        const { handle, calls, transact } = makeRecordingHandle(real);
        expect(duplicateSelected(handle, "c")).toBe(true);
        expect(removeSelected(handle, "d")).toBe(true);
        expect(duplicateSelected(handle, "zz")).toBe(false);
        expect(removeSelected(handle, "zz")).toBe(false);
        expect(transact).toHaveBeenCalledTimes(2);
        expect(calls).toEqual([
            ["duplicateSubtree", "c"],
            ["removeNode", "d"],
        ]);
    });

    it("Editar: setInlineEditing SOLO si el registry declara inline para el type", () => {
        const { handle: real, registry } = makeRealEditor();
        const { handle, setInlineEditing } = makeRecordingHandle(real);
        expect(editSelectedInline(handle, registry, "a")).toBe(true);
        expect(setInlineEditing).toHaveBeenCalledWith("a");
        setInlineEditing.mockClear();
        expect(editSelectedInline(handle, registry, "c")).toBe(false); // Card sin inline
        expect(editSelectedInline(handle, registry, "zz")).toBe(false);
        expect(setInlineEditing).not.toHaveBeenCalled();
    });
});

describe("contraste con el editor REAL (semántica post-remoción de moveNode)", () => {
    it("subir/bajar reordena de verdad el slot y undo lo revierte", () => {
        const { handle } = makeRealEditor();
        expect(moveSelected(handle, "c", -1)).toBe(true);
        expect(handle.getDoc().nodes["s1"].slots.children).toEqual(["c", "b", "d"]);
        expect(moveSelected(handle, "c", 1)).toBe(true);
        expect(handle.getDoc().nodes["s1"].slots.children).toEqual(["b", "c", "d"]);
        expect(handle.undo()).toBe(true);
        expect(handle.undo()).toBe(true);
        expect(handle.getDoc().nodes["s1"].slots.children).toEqual(["b", "c", "d"]);
        // El documento serializado quedó EXACTO al original tras deshacer.
        expect(handle.getData()).toEqual(makeData());
    });

    it("duplicar inserta el clon junto al original y borrar lo retira", () => {
        const { handle } = makeRealEditor();
        expect(duplicateSelected(handle, "c")).toBe(true);
        const children = handle.getDoc().nodes["s1"].slots.children;
        expect(children).toHaveLength(4);
        expect(children[1]).toBe("c");
        const cloneId = children[2];
        expect(cloneId).not.toBe("c");
        expect(handle.getDoc().nodes[cloneId].type).toBe("Card");
        expect(removeSelected(handle, cloneId)).toBe(true);
        expect(handle.getDoc().nodes["s1"].slots.children).toEqual(["b", "c", "d"]);
    });
});
