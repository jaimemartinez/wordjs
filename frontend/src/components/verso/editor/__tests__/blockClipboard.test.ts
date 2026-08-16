/**
 * F3 ola 3 — clipboard de bloques/estilos (checklist W03 Ctrl+C/V + W26):
 *
 *  - Regeneración RECURSIVA de ids al pegar (ningún id repetido, slots anidados incluidos),
 *    sobre la MISMA forma que produce el legacy (fixture generado con buildPatternBlocks de
 *    lib/blockPatterns — el productor real del motor viejo, no una imitación).
 *  - Interop cross-editor: misma clave localStorage (wjs_block_clipboard) y misma validación
 *    (`item.type && item.props`) — lo escrito por el legacy pega en Verso y viceversa.
 *  - Pegar = UNA transacción = UNA entrada de undo; posición: tras la selección (mismo slot del
 *    padre) o al final de la raíz.
 *  - Clipboard de estilos: forma EXACTA {look, anim, hide} bajo wjs_style_clipboard.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPatternBlocks, regenIds, type Pattern } from "@/lib/blockPatterns";
import { createEditor } from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockRegistry } from "@/lib/verso/registry";
import type { VersoItem } from "@/lib/verso/types";
import {
    BLOCK_CLIPBOARD_KEY,
    STYLE_CLIPBOARD_KEY,
    copySelectedSubtree,
    copyStylesFromSelected,
    pasteFromClipboard,
    pasteStylesToSelected,
    readBlockClipboard,
    writeBlockClipboard,
} from "../blockClipboard";

/* localStorage simulado (los tests corren en node): el mismo Map respalda "ambas pestañas". */
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
            type: "Section",
            label: "Sección",
            fields: { pad: { type: "number" }, children: { type: "slot" } },
            defaultProps: { pad: 4, children: [] },
            render: () => null,
        },
        {
            type: "Columns",
            label: "Columnas",
            fields: { cols: { type: "slot" } },
            defaultProps: { cols: [] },
            render: () => null,
        },
        {
            type: "Heading",
            label: "Título",
            fields: { title: { type: "text" } },
            defaultProps: { title: "Un título", look: {}, anim: { type: "fade-up" }, hide: {} },
            render: () => null,
        },
        {
            type: "Text",
            label: "Texto",
            fields: { content: { type: "textarea" } },
            defaultProps: { content: "..." },
            render: () => null,
        },
    ]);
    return r;
}

/** Componentes con la forma que consume el productor LEGACY (defaultProps por tipo). */
const legacyComponents: Record<string, { defaultProps: Record<string, unknown> }> = {
    Section: { defaultProps: { pad: 4, children: [] } },
    Columns: { defaultProps: { cols: [] } },
    Heading: { defaultProps: { title: "Un título" } },
    Text: { defaultProps: { content: "..." } },
};

/** Patrón anidado (slots de 2 niveles) construido por el builder REAL del legacy. */
const nestedPattern: Pattern = {
    id: "fixture",
    name: "Fixture",
    icon: "fa-grip",
    description: "fixture anidado",
    blocks: [
        {
            type: "Section",
            props: { pad: 8 },
            slots: {
                children: [
                    { type: "Heading", props: { title: "Hola" } },
                    {
                        type: "Columns",
                        slots: { cols: [{ type: "Text", props: { content: "col" } }] },
                    },
                ],
            },
        },
    ],
};

function legacyNestedItem(): VersoItem {
    return buildPatternBlocks(nestedPattern, legacyComponents)[0] as VersoItem;
}

function collectIds(item: VersoItem, out: string[] = []): string[] {
    out.push(item.props.id);
    for (const v of Object.values(item.props)) {
        if (Array.isArray(v)) {
            for (const c of v) {
                if (c && typeof c === "object" && (c as VersoItem).type && (c as VersoItem).props) {
                    collectIds(c as VersoItem, out);
                }
            }
        }
    }
    return out;
}

function makeHandle(registry: BlockRegistry, content: VersoItem[] = []) {
    return createEditor({
        initialData: { content, root: { props: {} } },
        isSlot: makeSlotResolver(registry),
    });
}

beforeEach(() => {
    store.clear();
});

describe("regeneración recursiva de ids (regenIds del legacy, semántica compartida)", () => {
    it("ningún id del original sobrevive y no hay repetidos — slots anidados incluidos", () => {
        const original = legacyNestedItem();
        const originalIds = collectIds(original);
        expect(originalIds.length).toBe(4); // Section + Heading + Columns + Text

        const fresh = regenIds(original) as VersoItem;
        const freshIds = collectIds(fresh);
        expect(freshIds.length).toBe(4);
        expect(new Set(freshIds).size).toBe(4); // sin repetidos
        for (const id of freshIds) expect(originalIds).not.toContain(id);
        // El contenido NO se toca — solo los ids.
        expect(fresh.type).toBe("Section");
        expect(fresh.props.pad).toBe(8);
    });

    it("pegar el MISMO clipboard dos veces jamás colisiona ids en el doc", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        writeBlockClipboard(legacyNestedItem());
        const id1 = pasteFromClipboard(handle, registry);
        const id2 = pasteFromClipboard(handle, registry);
        expect(id1).toBeTruthy();
        expect(id2).toBeTruthy();
        expect(id1).not.toBe(id2);
        const allIds = handle.getData().content.flatMap((i) => collectIds(i));
        expect(new Set(allIds).size).toBe(allIds.length);
    });
});

describe("interop cross-editor (misma clave, misma forma que el legacy)", () => {
    it("un item escrito por el productor legacy pega en Verso con hijos anidados intactos", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        // Simula el Ctrl+C del editor VIEJO: escribe el item crudo bajo la misma clave.
        localStorage.setItem(BLOCK_CLIPBOARD_KEY, JSON.stringify(legacyNestedItem()));

        const newId = pasteFromClipboard(handle, registry);
        expect(newId).toBeTruthy();
        const pasted = handle.getData().content[0];
        expect(pasted.type).toBe("Section");
        expect(pasted.props.id).toBe(newId);
        const children = pasted.props.children as VersoItem[];
        expect(children.map((c) => c.type)).toEqual(["Heading", "Columns"]);
        expect((children[1].props.cols as VersoItem[])[0].props.content).toBe("col");
    });

    it("copySelectedSubtree escribe una forma que el LECTOR legacy acepta (type + props, hijos en props)", () => {
        const registry = makeRegistry();
        const item = legacyNestedItem();
        const handle = makeHandle(registry, [item]);
        handle.select(item.props.id);
        expect(copySelectedSubtree(handle)).toBe(true);

        // El criterio de lectura del legacy (PuckEditor readBlockClipboard): parse + type + props.
        const raw = localStorage.getItem(BLOCK_CLIPBOARD_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw as string) as VersoItem;
        expect(parsed.type).toBe("Section");
        expect(parsed.props).toBeTruthy();
        // Round-trip exacto del subtree (el doc de Verso serializa el subtree byte-igual).
        expect(parsed).toEqual(item);
        // Y el lector de este módulo también lo acepta (simetría).
        expect(readBlockClipboard()).toEqual(item);
    });

    it("clipboard con tipo NO registrado en este editor → no-op (paridad legacy)", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        localStorage.setItem(BLOCK_CLIPBOARD_KEY, JSON.stringify({ type: "PluginBlock", props: { id: "x" } }));
        expect(pasteFromClipboard(handle, registry)).toBe(null);
        expect(handle.getData().content).toEqual([]);
        expect(handle.canUndo()).toBe(false);
    });

    it("clipboard malformado o ausente → null sin lanzar", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        expect(pasteFromClipboard(handle, registry)).toBe(null);
        localStorage.setItem(BLOCK_CLIPBOARD_KEY, "{no-json");
        expect(pasteFromClipboard(handle, registry)).toBe(null);
        localStorage.setItem(BLOCK_CLIPBOARD_KEY, JSON.stringify({ sin: "forma" }));
        expect(pasteFromClipboard(handle, registry)).toBe(null);
    });
});

describe("posición del pegado + historia", () => {
    it("pega TRAS la selección en su mismo slot; sin selección, al final de la raíz", () => {
        const registry = makeRegistry();
        const a: VersoItem = { type: "Heading", props: { id: "h-a", title: "A" } };
        const b: VersoItem = { type: "Heading", props: { id: "h-b", title: "B" } };
        const handle = makeHandle(registry, [a, b]);
        writeBlockClipboard({ type: "Text", props: { id: "t-1", content: "pegado" } });

        handle.select("h-a");
        const idAfterSel = pasteFromClipboard(handle, registry);
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["h-a", idAfterSel, "h-b"]);

        handle.select(null);
        const idAtEnd = pasteFromClipboard(handle, registry);
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["h-a", idAfterSel, "h-b", idAtEnd]);
    });

    it("un pegado = UNA entrada de undo (subtree entero se revierte de un Ctrl+Z)", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        writeBlockClipboard(legacyNestedItem());
        expect(pasteFromClipboard(handle, registry)).toBeTruthy();
        expect(handle.canUndo()).toBe(true);
        expect(handle.undo()).toBe(true);
        expect(handle.getData().content).toEqual([]);
        expect(handle.canUndo()).toBe(false); // era exactamente UNA entrada
    });
});

describe("clipboard de ESTILOS (wjs_style_clipboard, forma {look,anim,hide})", () => {
    it("copia la tripleta del seleccionado (defaults {}) y la pega vía setProps en un solo undo", () => {
        const registry = makeRegistry();
        const src: VersoItem = {
            type: "Heading",
            props: { id: "h-src", title: "Src", look: { bg: "#fff" }, anim: { type: "zoom", duration: 300 } },
        };
        const dst: VersoItem = { type: "Text", props: { id: "t-dst", content: "intacto" } };
        const handle = makeHandle(registry, [src, dst]);

        handle.select("h-src");
        expect(copyStylesFromSelected(handle)).toBe(true);
        const payload = JSON.parse(localStorage.getItem(STYLE_CLIPBOARD_KEY) as string);
        // Forma EXACTA del legacy: las tres claves, hide cae a {}.
        expect(Object.keys(payload).sort()).toEqual(["anim", "hide", "look"]);
        expect(payload.look).toEqual({ bg: "#fff" });
        expect(payload.hide).toEqual({});

        handle.select("t-dst");
        expect(pasteStylesToSelected(handle)).toBe(true);
        const after = handle.getData().content[1];
        expect(after.props.look).toEqual({ bg: "#fff" });
        expect(after.props.anim).toEqual({ type: "zoom", duration: 300 });
        expect(after.props.content).toBe("intacto"); // el contenido NUNCA se toca

        const undoDepthBefore = handle.canUndo();
        expect(undoDepthBefore).toBe(true);
        handle.undo(); // UNA entrada revierte el pegado de estilos completo
        expect(handle.getData().content[1].props.look).toBeUndefined();
    });

    it("sin selección o clipboard malformado → false sin tocar el doc", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Text", props: { id: "t-1", content: "x" } }]);
        expect(copyStylesFromSelected(handle)).toBe(false);
        handle.select("t-1");
        expect(pasteStylesToSelected(handle)).toBe(false); // clipboard vacío
        localStorage.setItem(STYLE_CLIPBOARD_KEY, "{roto");
        expect(pasteStylesToSelected(handle)).toBe(false);
        expect(handle.canUndo()).toBe(false);
    });
});
